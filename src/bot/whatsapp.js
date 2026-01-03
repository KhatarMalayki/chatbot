const { Client, LocalAuth, Buttons, List } = require('whatsapp-web.js');
const Tesseract = require('tesseract.js');
const qrcode = require('qrcode-terminal');
const logger = require('../utils/logger');
const config = require('../utils/config');
const AiAgent = require('../agent/aiAgent');
const ticketQueue = require('../queue/ticketQueue');
const KoprolAutomation = require('../automation/koprol');
const assignmentState = require('../state/assignmentState');
const breakState = require('../state/breakState');
const endBreakState = require('../state/endBreakState');
const doneState = require('../state/doneState');

const LEVEL_ALIASES = {
    low: 'Low',
    rendah: 'Low',
    medium: 'Medium',
    sedang: 'Medium',
    mid: 'Medium',
    high: 'High',
    tinggi: 'High'
};

const PIC_OPTIONS = [
    'ANGGRIONO',
    'DEO HERNOWO',
    'ERICK INDRA TARA',
    'MAULIGA PENYEJUKNATE',
    'MOHAMAD KHATAR MALAYKI',
    'MUHAMAD RUBYANSYAH PUTRA',
    'MUHAMMAD RISALDI'
];

const DONE_QUESTIONS = [
    {
        key: 'impact',
        label: 'Impact',
        prompt: `⚠️ *Impact*\nPilih tingkat impact: *Low / Medium / High*.`,
        validate: (text) => normalizeLevelAnswer(text),
        retry: 'Impact hanya bisa: *Low, Medium, High*.'
    },
    {
        key: 'urgency',
        label: 'Urgency',
        prompt: `⏱️ *Urgency*\nPilih tingkat urgency: *Low / Medium / High*.`,
        validate: (text) => normalizeLevelAnswer(text),
        retry: 'Urgency hanya bisa: *Low, Medium, High*.'
    },
    {
        key: 'rca',
        label: 'RCA',
        prompt: '🧠 *RCA*\nApa Root Cause Analysis-nya? (minimal 5 karakter)',
        validate: (text) => {
            const value = (text || '').trim();
            return value.length >= 5 ? value : null;
        },
        retry: 'RCA terlalu singkat. Jelaskan minimal 5 karakter.'
    },
    {
        key: 'solution',
        label: 'Solusi',
        prompt: '🛠️ *Solusi*\nApa solusi yang dijalankan? (minimal 5 karakter)',
        validate: (text) => {
            const value = (text || '').trim();
            return value.length >= 5 ? value : null;
        },
        retry: 'Solusi terlalu singkat. Jelaskan minimal 5 karakter.'
    },
    {
        key: 'dueDays',
        label: 'Due Date (Days)',
        prompt:
            '📅 *Due Date Offset (Hari)*\n' +
            'Mau diisi berapa *Days* di dialog *Set Due Date*?\n' +
            '- Ketik angka, misal *6* untuk 6.00 Days.\n' +
            '- Ketik *0* kalau mau bot hitung otomatis (H+1 dari Due Date lama).',
        validate: (text) => {
            if (typeof text !== 'string') return null;
            const raw = text.trim();
            if (!raw.length) return null;
            const normalized = raw.replace(',', '.');
            const num = parseFloat(normalized);
            if (Number.isNaN(num) || num < 0) return null;
            // Simpan sebagai string apa adanya agar mudah dilog dan diparse ulang di automation
            return normalized;
        },
        retry:
            'Isi angka jumlah hari yang valid, contoh *6* untuk 6.00 Days, atau *0* kalau mau bot hitung otomatis.'
    }
];

const PIC_LIST_TEXT = PIC_OPTIONS.map((name, idx) => `${idx + 1}. ${name}`).join('\n');
const OUTSTANDING_CACHE_TTL = 2 * 60 * 1000; // 2 menit
const TICKET_RATING_TIMEOUT_MS = 10 * 60 * 1000;

function normalizeLevelAnswer(text) {
    if (!text) {
        return null;
    }
    const normalized = text.trim().toLowerCase();
    return LEVEL_ALIASES[normalized] || null;
}

function normalizePicChoice(text) {
    if (!text) {
        return null;
    }
    const raw = text.trim();
    const asNumber = parseInt(raw, 10);
    if (!Number.isNaN(asNumber) && asNumber >= 1 && asNumber <= PIC_OPTIONS.length) {
        return PIC_OPTIONS[asNumber - 1];
    }
    const lower = raw.toLowerCase();
    for (const name of PIC_OPTIONS) {
        if (name.toLowerCase().includes(lower)) {
            return name;
        }
    }
    return null;
}

function isTaskOnBreak(task = {}) {
    const state = (task.state || '').toLowerCase();
    const clock = (task.clock || '').toLowerCase();
    return clock.includes('break') || state.includes('break');
}

const ASSIGNMENT_QUESTIONS = [
    {
        key: 'pic',
        label: 'PIC',
        prompt: `👤 *PIC*
Siapa PIC yang akan menangani tiket ini?

Pilih salah satu dari daftar berikut (kirim *nomor* atau *nama*):
${PIC_LIST_TEXT}

Contoh balasan:
• 5
• KHATAR`,
        validate: (text) => {
            const choice = normalizePicChoice(text);
            return choice;
        },
        retry: 'PIC tidak dikenali. Kirim angka *1-7* atau ketik nama PIC yang ada di daftar.'
    },
    {
        key: 'impact',
        label: 'Impact',
        prompt: `⚠️ *Impact*
Pilih tingkat impact: *Low / Medium / High*.`,
        validate: (text) => normalizeLevelAnswer(text),
        retry: 'Impact hanya bisa: *Low, Medium, High*.'
    },
    {
        key: 'urgency',
        label: 'Urgency',
        prompt: `⏱️ *Urgency*
Pilih tingkat urgency: *Low / Medium / High*.`,
        validate: (text) => normalizeLevelAnswer(text),
        retry: 'Urgency hanya bisa: *Low, Medium, High*.'
    }
];

const TICKET_REGEX = /RF\/[A-Z]{2}\/\d{2}\/\d{2}\/\d{5}/i;

function extractTicketId(text = '') {
    const match = text.match(TICKET_REGEX);
    return match ? match[0].toUpperCase() : null;
}

function extractTicketIdLoose(text = '') {
    const raw = (text || '').toUpperCase();
    if (!raw) return null;
    // tolerate whitespace/newlines and common OCR confusions
    const cleaned = raw
        .replace(/[\s\u00A0]+/g, '')
        .replace(/O/g, '0')
        .replace(/I/g, '1')
        .replace(/\|/g, '1');

    const loose = cleaned.match(/RF\/[A-Z0-9]{2}\/[0-9]{2}\/[0-9]{2}\/[0-9]{5}/i);
    return loose ? loose[0].toUpperCase() : null;
}

function normalizePhoneToJid(rawPhone = '') {
    let phone = String(rawPhone || '').replace(/[^0-9]/g, '');
    if (!phone) return null;
    if (phone.startsWith('0')) {
        phone = '62' + phone.slice(1);
    }
    return phone.endsWith('@c.us') ? phone : `${phone}@c.us`;
}

function buildNumberedOptions(options = []) {
    return options.map((opt, idx) => `${idx + 1}. ${opt}`).join('\n');
}

class WhatsAppBot {
    constructor() {
        this.client = new Client({
            authStrategy: new LocalAuth({ clientId: 'koprol-dispatcher' }),
            restartOnAuthFail: true,
            takeoverOnConflict: true,
            takeoverTimeoutMs: 30000,
            puppeteer: {
                headless: config.selenium.headless,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu'
                ]
            }
        });

        this.koprolBot = new KoprolAutomation();
        this.agent = new AiAgent(config.agent);

        // Sesi & cache sederhana untuk kredensial Koprol per user saat cek outstanding
        this.outstandingCredentialSessions = new Map(); // key: userId/chatId, value: true jika menunggu cred
        this.outstandingCredentials = new Map(); // key: userId/chatId, value: { username, password }

        this.koprolRequestSessions = new Map();
        this.ticketRatingSessions = new Map();

        this.setupEventHandlers();
        this.startReminderLoop();
    }

    setupEventHandlers() {
        // Tampilkan QR di terminal saat pertama kali login
        this.client.on('qr', (qr) => {
            try {
                qrcode.generate(qr, { small: true });
                logger.info('QR code received, please scan with WhatsApp');
            } catch (e) {
                logger.warn('Failed to render QR code', e.message || e);
            }
        });

        this.client.on('ready', () => {
            logger.info('WhatsApp client is ready');
        });

        this.client.on('authenticated', () => {
            logger.info('WhatsApp authenticated');
        });

        this.client.on('auth_failure', (msg) => {
            logger.error('Authentication failure', msg);
        });

        this.client.on('disconnected', (reason) => {
            logger.warn('WhatsApp disconnected:', reason);
        });

        // Routing utama pesan masuk ke handler bot
        this.client.on('message', async (message) => {
            await this.handleMessage(message);
        });

        // Izinkan command diawali "!" dari pesan yang dikirim sendiri
        this.client.on('message_create', async (message) => {
            if (message.fromMe && typeof message.body === 'string' && message.body.startsWith('!')) {
                await this.handleMessage(message);
            }
        });

        this.client.on('remote_session_saved', () => {
            logger.info('Remote session saved');
        });

        this.client.on('loading_screen', (percent, message) => {
            logger.info(`Loading: ${percent}% - ${message}`);
        });

        this.client.on('change_state', (state) => {
            logger.info(`State changed: ${state}`);
        });

        // Log error dari Puppeteer (tidak fatal, hanya untuk diagnosa)
        if (this.client.pupBrowser) {
            this.client.pupBrowser.on('error', (error) => {
                if (error && error.message) {
                    logger.warn('Browser error (non-critical):', error.message);
                }
            });
        }

        if (this.client.pupPage) {
            this.client.pupPage.on('error', (error) => {
                if (error && error.message) {
                    logger.warn('Page error (non-critical):', error.message);
                }
            });
        }
    }

    buildOutstandingMessage(tasks = [], picName) {
        if (!tasks.length) {
            return `✅ Tidak ada outstanding task untuk *${picName || 'PIC ini'}*.`;
        }

        const lines = tasks.map((task, idx) => {
            const chunks = [];
            chunks.push(`*${idx + 1}. ${task.ticket || '-'}*`);
            if (task.request) chunks.push(task.request);
            if (task.user) chunks.push(`User: ${task.user}`);
            if (task.assignDate) chunks.push(`Assign: ${task.assignDate}`);
            if (task.dueDate) chunks.push(`Due: ${task.dueDate}`);
            const status = [task.state || '', task.clock || ''].filter(Boolean).join(' • ');
            if (status) chunks.push(status);
            return chunks.join('\n');
        });

        return `📋 *Outstanding Task - ${picName || 'PIC'}*\n\n${lines.join('\n\n')}`;
    }

    async startOutstandingCredentialFlow(chat, userId = '') {
        const key = userId || chat?.id?._serialized || chat?.id || 'global';

        if (this.outstandingCredentialSessions.get(key)) {
            await chat.sendMessage(
                '🔐 Masih menunggu kredensial Koprol.\n' +
                    'Kirim *username|password* Koprol kamu, contoh: `khatar|P@ssw0rd`.'
            );
            return;
        }

        this.outstandingCredentialSessions.set(key, true);
        await chat.sendMessage(
            '🔐 Untuk cek *Outstanding* di Koprol, kirim *username|password* Koprol kamu.\n' +
                'Contoh: `khatar|P@ssw0rd`.\n' +
                'Cred ini hanya dipakai sekali untuk login, tidak disimpan permanen.'
        );
    }

    parseKoprolCredentials(text = '') {
        if (!text) return null;
        const raw = text.trim();
        const parts = raw.split('|');
        if (parts.length !== 2) return null;
        const username = parts[0].trim();
        const password = parts[1].trim();
        if (!username || !password) return null;
        return { username, password };
    }

    async tryHandleOutstandingCredentialConversation(chat, userId, text) {
        const key = userId || chat?.id?._serialized || chat?.id || 'global';
        if (!this.outstandingCredentialSessions.get(key)) {
            return false;
        }

        const creds = this.parseKoprolCredentials(text);
        if (!creds) {
            await chat.sendMessage(
                '❌ Format kredensial tidak valid.\n' +
                    'Kirim lagi dengan format: *username|password* (tanpa spasi di kiri/kanan).'
            );
            return true;
        }

        // Simpan kredensial untuk sesi ini dan hapus status "menunggu cred"
        this.outstandingCredentials.set(key, creds);
        this.outstandingCredentialSessions.delete(key);

        await chat.sendMessage('✅ Kredensial Koprol diterima. Mengambil daftar *Outstanding*...');

        // Jalankan perintah outstanding dengan kredensial yang diberikan
        await this.handleOutstandingCommand(chat, userId, '', { credentials: creds });
        return true;
    }

    getOutstandingCacheKey(userId, chat) {
        return userId || chat?.id?._serialized || chat?.id || null;
    }

    async handleOutstandingCommand(chat, userId = '', picNameOverride = '', options = {}) {
        const picName = picNameOverride || (config.admin && config.admin.picName) || 'MOHAMAD KHATAR MALAYKI';
        const cacheKey = this.getOutstandingCacheKey(userId, chat);
        const cachedOutstanding = cacheKey ? breakState.getOutstanding(cacheKey) : null;
        
        await chat.sendMessage(
            `⏳ Sedang membuka Outstanding Task di *Koprol* untuk *${picName}*...\nIni bisa perlu sekitar 10–15 detik, mohon tunggu ya.`
        );

        // Jika ada kredensial dari WA, gunakan untuk login Koprol
        const credentials = (options && options.credentials) || {};
        const checker = new KoprolAutomation(credentials);
        try {
            const tasks = await checker.fetchOutstandingTasks(picName, 10);
            const message = this.buildOutstandingMessage(tasks, picName);
            await chat.sendMessage(message);

            if (cacheKey) {
                breakState.setOutstanding(cacheKey, { tasks, picName });
            }
        } catch (err) {
            logger.error('Failed to fetch outstanding tasks', err);
            const rawMessage = err && err.message ? String(err.message) : String(err || '');
            if (cachedOutstanding && Array.isArray(cachedOutstanding.tasks)) {
                const fallback = this.buildOutstandingMessage(cachedOutstanding.tasks, picName);
                await chat.sendMessage(
                    `⚠️ Refresh data gagal (${rawMessage}). Menampilkan data terakhir yang tersimpan.\n\n${fallback}`
                );
            } else {
                if (rawMessage.includes('Outstanding Task list tidak bisa dibuka')) {
                    await chat.sendMessage(
                        '❌ Gagal membuka daftar Outstanding di Koprol (halaman kosong/tidak merespon).\n\n' +
                        'Kemungkinan ada gangguan di server Koprol atau koneksi jaringan. Coba lagi beberapa menit lagi atau cek langsung di browser Koprol.\n\n' +
                        `Detail teknis: ${rawMessage}`
                    );
                } else {
                    await chat.sendMessage(`❌ Gagal mengambil Outstanding Task.\nPesan: ${rawMessage}`);
                }
            }
        } finally {
            try {
                await checker.close();
            } catch (e) {}
        }
    }

    async handleEndBreakCommand(chat, userId, rawText = '') {
        const activeSession = endBreakState.get(userId);
        if (activeSession) {
            await chat.sendMessage('⚠️ Kamu masih dalam proses End Break. Selesaikan dulu atau ketik *batal*.');
            return;
        }

        const picName = config.admin.picName || 'MOHAMAD KHATAR MALAYKI';
        const cacheKey = this.getOutstandingCacheKey(userId, chat);
        const cachedOutstanding = cacheKey ? breakState.getOutstanding(cacheKey) : null;
        const isCacheFresh =
            cachedOutstanding &&
            cachedOutstanding.picName === picName &&
            Array.isArray(cachedOutstanding.tasks) &&
            Date.now() - (cachedOutstanding.fetchedAt || cachedOutstanding.updatedAt || 0) <= OUTSTANDING_CACHE_TTL;

        if (!isCacheFresh) {
            await chat.sendMessage(
                'ℹ️ Data Outstanding belum tersedia atau sudah lebih dari 2 menit.\n' +
                'Ketik *outstanding* dulu supaya bot ambil data terbaru, lalu ulangi perintah *end break*.'
            );
            return;
        }

        const tasks = cachedOutstanding.tasks || [];

        const onBreak = tasks.filter((t) => this.isTaskOnBreak(t));
        if (!onBreak.length) {
            await chat.sendMessage('✅ Tidak ada ticket dengan status *Break* saat ini.');
            return;
        }

        const requestedTicket = extractTicketId(rawText);
        let directTask = null;
        if (requestedTicket) {
            directTask = onBreak.find(
                (task) => (task.ticket || '').toUpperCase() === requestedTicket
            );
        }

        if (directTask || onBreak.length === 1) {
            const chosen = directTask || onBreak[0];
            endBreakState.start(userId, {
                stage: 'executing',
                selectedTicket: chosen.ticket,
                chatId: chat.id._serialized,
                picName,
            });
            await this.executeEndBreak(chat, userId, chosen.ticket);
            return;
        }

        endBreakState.start(userId, {
            stage: 'awaiting_ticket',
            tasks: onBreak,
            chatId: chat.id._serialized,
            picName,
        });

        const optionsText = this.formatOptionsList(onBreak, false);
        await chat.sendMessage(
            `🔢 Pilih ticket yang mau di-*End Break* (kirim angka atau nomor tiket):\n\n${optionsText}`
        );
    }

    async tryHandleEndBreakConversation(chat, userId, text) {
        const session = endBreakState.get(userId);
        if (!session) {
            return false;
        }

        const lower = (text || '').trim().toLowerCase();
        if (lower === 'batal' || lower === '/batal' || lower === 'cancel') {
            endBreakState.clear(userId);
            await chat.sendMessage('❎ Proses End Break dibatalkan.');
            return true;
        }

        if (session.stage === 'awaiting_ticket') {
            const ticketId = extractTicketId(text);
            let chosenTask = null;

            if (ticketId) {
                chosenTask = (session.tasks || []).find(
                    (task) => (task.ticket || '').toUpperCase() === ticketId
                );
            } else {
                const asNumber = parseInt((text || '').trim(), 10);
                if (!Number.isNaN(asNumber) && session.tasks && session.tasks[asNumber - 1]) {
                    chosenTask = session.tasks[asNumber - 1];
                }
            }

            if (!chosenTask) {
                await chat.sendMessage(
                    `❌ Pilihan tidak valid. Kirim angka 1-${(session.tasks || []).length} atau ketik nomor tiket lengkap.`
                );
                return true;
            }

            endBreakState.update(userId, {
                stage: 'executing',
                selectedTicket: chosenTask.ticket,
                tasks: [],
            });
            await this.executeEndBreak(chat, userId, chosenTask.ticket);
            return true;
        }

        if (session.stage === 'executing') {
            await chat.sendMessage('⏳ Proses End Break masih berjalan. Mohon tunggu...');
            return true;
        }

        return false;
    }

    async executeEndBreak(chat, userId, ticketId) {
        if (!ticketId) {
            endBreakState.clear(userId);
            await chat.sendMessage('❌ Ticket belum dipilih. Silakan ketik *end break* lagi.');
            return;
        }

        await chat.sendMessage(`⚙️ Menjalankan End Break untuk tiket *${ticketId}*...`);

        const breaker = new KoprolAutomation();
        try {
            await breaker.endBreakOutstandingTicket(ticketId);
            await chat.sendMessage(`✅ Ticket *${ticketId}* berhasil di-End Break.`);
            const cacheKey = this.getOutstandingCacheKey(userId, chat);
            breakState.removeOutstandingTicket(cacheKey, ticketId);
        } catch (error) {
            logger.error('Failed to end break ticket', error);
            await chat.sendMessage(
                `❌ Gagal End Break tiket *${ticketId}*.\nPesan: ${error.message || error}\n\nSilakan coba lagi dengan mengetik *end break*.`
            );
        } finally {
            endBreakState.clear(userId);
            try {
                await breaker.close();
            } catch (e) {}
        }
    }

    isTaskOnProgress(task = {}) {
        const state = (task.state || '').toLowerCase();
        const clock = (task.clock || '').toLowerCase();
        return state.includes('progress') || clock.includes('progress');
    }

    formatOptionsList(tasks = [], withStatus = true) {
        return tasks
            .map((task, idx) => {
                const parts = [`*${idx + 1}. ${task.ticket || '-'}*`];
                if (task.user) parts.push(`User: ${task.user}`);
                if (task.assignDate) parts.push(`Assign: ${task.assignDate}`);
                if (task.dueDate) parts.push(`Due: ${task.dueDate}`);
                if (withStatus) {
                    const status = [task.state || '', task.clock || ''].filter(Boolean).join(' • ');
                    if (status) parts.push(status);
                }
                return parts.join('\n');
            })
            .join('\n\n');
    }

    isTaskOnBreak(task = {}) {
        const state = (task.state || '').toLowerCase();
        const clock = (task.clock || '').toLowerCase();
        return clock.includes('break') || state.includes('break');
    }

    async handleBreakCommand(chat, userId, rawText = '') {
        const activeSession = breakState.get(userId);
        if (activeSession) {
            await chat.sendMessage('⚠️ Kamu masih dalam proses Break tiket. Jawab pertanyaan sebelumnya atau ketik *batal* untuk membatalkan.');
            return;
        }

        const picName = config.admin.picName || 'MOHAMAD KHATAR MALAYKI';
        const cacheKey = this.getOutstandingCacheKey(userId, chat);
        const cachedOutstanding = cacheKey ? breakState.getOutstanding(cacheKey) : null;
        const isCacheFresh =
            cachedOutstanding &&
            cachedOutstanding.picName === picName &&
            Array.isArray(cachedOutstanding.tasks) &&
            Date.now() - (cachedOutstanding.fetchedAt || cachedOutstanding.updatedAt || 0) <= OUTSTANDING_CACHE_TTL;

        if (!isCacheFresh) {
            await chat.sendMessage(
                'ℹ️ Data Outstanding belum tersedia atau sudah lebih dari 2 menit.\n' +
                'Ketik *outstanding* dulu supaya bot ambil data terbaru, lalu ulangi perintah *break*.'
            );
            return;
        }

        const tasks = cachedOutstanding.tasks || [];

        const onProgress = tasks.filter((t) => this.isTaskOnProgress(t));
        if (!onProgress.length) {
            await chat.sendMessage('✅ Tidak ada ticket dengan status *On Progress* saat ini. Semua sudah Break / selesai.');
            return;
        }

        const requestedTicket = extractTicketId(rawText);
        let directTask = null;
        if (requestedTicket) {
            directTask = onProgress.find(
                (task) => (task.ticket || '').toUpperCase() === requestedTicket
            );
        }

        if (directTask || onProgress.length === 1) {
            const chosen = directTask || onProgress[0];
            breakState.start(userId, {
                stage: 'awaiting_reason',
                selectedTicket: chosen.ticket,
                chatId: chat.id._serialized,
                picName,
            });
            await chat.sendMessage(
                `🎯 Ticket *${chosen.ticket}* (${chosen.user || 'User tidak diketahui'}) akan di-Break.\n\nKetik alasan break-nya ya (contoh: *menunggu konfirmasi user*).`
            );
            return;
        }

        breakState.start(userId, {
            stage: 'awaiting_ticket',
            tasks: onProgress,
            chatId: chat.id._serialized,
            picName,
        });

        const optionsText = this.formatOptionsList(onProgress);
        await chat.sendMessage(
            `🔢 Pilih ticket yang mau di-Break (kirim angka atau ketik nomor tiket):\n\n${optionsText}`
        );
    }

    async tryHandleBreakConversation(chat, userId, text) {
        const session = breakState.get(userId);
        if (!session) {
            return false;
        }

        const lower = (text || '').trim().toLowerCase();
        if (lower === 'batal' || lower === '/batal' || lower === 'cancel') {
            breakState.clear(userId);
            await chat.sendMessage('❎ Proses Break tiket dibatalkan.');
            return true;
        }

        if (session.stage === 'awaiting_ticket') {
            const ticketId = extractTicketId(text);
            let chosenTask = null;

            if (ticketId) {
                chosenTask = (session.tasks || []).find(
                    (task) => (task.ticket || '').toUpperCase() === ticketId
                );
            } else {
                const asNumber = parseInt((text || '').trim(), 10);
                if (!Number.isNaN(asNumber) && session.tasks && session.tasks[asNumber - 1]) {
                    chosenTask = session.tasks[asNumber - 1];
                }
            }

            if (!chosenTask) {
                await chat.sendMessage(
                    `❌ Pilihan tidak valid. Kirim angka 1-${(session.tasks || []).length} atau ketik nomor tiket lengkap.`
                );
                return true;
            }

            breakState.update(userId, {
                stage: 'awaiting_reason',
                selectedTicket: chosenTask.ticket,
                tasks: [],
            });
            await chat.sendMessage(
                `🎯 Ticket *${chosenTask.ticket}* dipilih.\nKetik alasan break-nya ya.`
            );
            return true;
        }

        if (session.stage === 'awaiting_reason') {
            if (!text || text.trim().length < 3) {
                await chat.sendMessage('⚠️ Alasan terlalu pendek. Coba jelaskan sedikit (minimal 3 karakter).');
                return true;
            }

            breakState.update(userId, { stage: 'executing' });
            await this.executeBreakTicket(chat, userId, session.selectedTicket, text.trim());
            return true;
        }

        if (session.stage === 'executing') {
            await chat.sendMessage('⏳ Masih menjalankan proses Break. Mohon tunggu...');
            return true;
        }

        return false;
    }

    async executeBreakTicket(chat, userId, ticketId, reasonText) {
        if (!ticketId) {
            breakState.clear(userId);
            await chat.sendMessage('❌ Ticket belum dipilih. Silakan ketik *break* lagi.');
            return;
        }

        await chat.sendMessage(
            `⚙️ Menjalankan Break untuk tiket *${ticketId}*...\nAlasan: ${reasonText}`
        );

        const breaker = new KoprolAutomation();
        try {
            await breaker.breakOutstandingTicket(ticketId, reasonText);
            await chat.sendMessage(
                `✅ Ticket *${ticketId}* berhasil di-Break.\n📝 Alasan: ${reasonText}`
            );
            const cacheKey = this.getOutstandingCacheKey(userId, chat);
            breakState.removeOutstandingTicket(cacheKey, ticketId);
        } catch (error) {
            logger.error('Failed to break ticket', error);
            await chat.sendMessage(
                `❌ Gagal Break tiket *${ticketId}*.\nPesan: ${error.message || error}\n\nSilakan coba lagi dengan mengetik *break*.`
            );
        } finally {
            breakState.clear(userId);
            try {
                await breaker.close();
            } catch (e) {}
        }
    }

    async handleDoneCommand(chat, userId, rawText = '') {
        const activeSession = doneState.get(userId);
        if (activeSession && activeSession.stage !== 'idle' && activeSession.stage !== 'completed') {
            await chat.sendMessage('⚠️ Kamu masih dalam proses Done tiket. Jawab pertanyaan sebelumnya atau ketik *batal* untuk membatalkan.');
            return;
        }

        const picName = config.admin.picName || 'MOHAMAD KHATAR MALAYKI';
        const cacheKey = this.getOutstandingCacheKey(userId, chat);
        const cachedOutstanding = cacheKey ? breakState.getOutstanding(cacheKey) : null;
        const isCacheFresh =
            cachedOutstanding &&
            cachedOutstanding.picName === picName &&
            Array.isArray(cachedOutstanding.tasks) &&
            Date.now() - (cachedOutstanding.fetchedAt || cachedOutstanding.updatedAt || 0) <= OUTSTANDING_CACHE_TTL;

        if (!isCacheFresh) {
            await chat.sendMessage(
                'ℹ️ Data Outstanding belum tersedia atau sudah lebih dari 2 menit.\n' +
                'Ketik *outstanding* dulu supaya bot ambil data terbaru, lalu ulangi perintah *done*.'
            );
            return;
        }

        const tasks = cachedOutstanding.tasks || [];

        const onProgress = tasks.filter((t) => this.isTaskOnProgress(t));
        if (!onProgress.length) {
            await chat.sendMessage('✅ Tidak ada ticket dengan status *On Progress* saat ini.');
            return;
        }

        const requestedTicket = extractTicketId(rawText);
        let directTask = null;
        if (requestedTicket) {
            directTask = onProgress.find(
                (task) => (task.ticket || '').toUpperCase() === requestedTicket
            );
        }

        if (directTask || onProgress.length === 1) {
            const chosen = directTask || onProgress[0];
            doneState.start(userId, {
                stage: 'collecting_answers',
                selectedTicket: chosen.ticket,
                tasks: [],
                chatId: chat.id._serialized,
                picName,
                pendingQuestions: DONE_QUESTIONS.map((q) => ({ ...q })),
                currentQuestion: null,
                answers: {},
            });
            await chat.sendMessage(
                `🎯 Ticket *${chosen.ticket}* dipilih.\nBot perlu 4 informasi sebelum menutup tiket: Impact, Urgency, RCA, dan Solusi.`
            );
            await this.sendTicketDateInfo(chat, chosen.ticket);
            await this.promptNextDoneQuestion(chat, userId);
            return;
        }

        doneState.start(userId, {
            stage: 'awaiting_ticket',
            tasks: onProgress,
            chatId: chat.id._serialized,
            picName,
        });

        const optionsText = this.formatOptionsList(onProgress);
        await chat.sendMessage(
            `🔢 Pilih ticket yang mau di-*Done* (kirim angka atau nomor tiket):\n\n${optionsText}`
        );
    }

    // === Public Koprol Ticketing (command: koprol) ===

    getKoprolSession(userId) {
        return this.koprolRequestSessions.get(userId) || null;
    }

    setKoprolSession(userId, data) {
        if (!userId) return;
        if (!data) {
            const existing = this.koprolRequestSessions.get(userId);
            // Pastikan WebDriver ditutup ketika sesi dibersihkan
            if (existing && existing.automation) {
                try {
                    existing.automation.close();
                } catch (e) {}
            }
            this.koprolRequestSessions.delete(userId);
        } else {
            this.koprolRequestSessions.set(userId, { ...(this.getKoprolSession(userId) || {}), ...data });
        }
    }

    getTicketRatingSession(userId) {
        return this.ticketRatingSessions.get(userId) || null;
    }

    setTicketRatingSession(userId, data) {
        if (!userId) return;
        if (!data) {
            this.ticketRatingSessions.delete(userId);
        } else {
            this.ticketRatingSessions.set(userId, { ...(this.getTicketRatingSession(userId) || {}), ...data });
        }
    }

    async startKoprolRequestFlow(chat, userId) {
        this.setKoprolSession(userId, {
            stage: 'awaiting_nik',
            payload: {},
            dropdowns: null,
            automation: null,
        });

        const msg =
            '🤖 *Selamat datang di Bot Koprol Ticketing Online*\n\n' +
            'Kalau kamu punya *request / problem / masalah*,\n' +
            'silakan isi *NIK* kamu terlebih dahulu ya.\n\n' +
            'Contoh: `scit19001`\n\n' +
            'Ketik NIK sekarang untuk mulai buat tiket. ✅';
        await chat.sendMessage(msg);
    }

    async tryHandleKoprolRequestConversation(chat, userId, text) {
        const session = this.getKoprolSession(userId);
        if (!session) {
            return false;
        }

        const lower = (text || '').trim().toLowerCase();
        if (lower === 'batal' || lower === '/batal' || lower === 'cancel') {
            this.setKoprolSession(userId, null);
            await chat.sendMessage('❎ Proses input tiket Koprol dibatalkan.');
            return true;
        }

        if (session.stage === 'awaiting_nik') {
            const nikRaw = (text || '').trim();
            if (!nikRaw) {
                await chat.sendMessage('⚠️ NIK tidak boleh kosong. Kirim lagi NIK yang benar, contoh: `scit19001`.');
                return true;
            }

            // NIK kantor: 4 huruf depan + 5 angka belakang (case-insensitive), contoh: scit19001, SOAD22003
            const nikPattern = /^[a-zA-Z]{4}[0-9]{5}$/;
            if (!nikPattern.test(nikRaw)) {
                await chat.sendMessage(
                    '⚠️ Format NIK tidak valid. Gunakan pola *4 huruf* di depan dan *5 angka* di belakang.\n' +
                        'Contoh yang benar: `scit19001`, `SOAD22003`.'
                );
                return true;
            }

            const nik = nikRaw;
            // Reuse existing automation if any, otherwise create new
            let inspector = (session && session.automation) || null;
            if (!inspector) {
                inspector = new KoprolAutomation();
            }
            let inspectOk = false;
            try {
                await chat.sendMessage(
                    `⏳ Mengecek NIK *${nik}* di Koprol (form publik)...`
                );
                const info = await inspector.inspectPublicRequestForm(nik);
                if (!info || !info.ok) {
                    const msg = info && info.errorMessage
                        ? info.errorMessage
                        : 'NIK belum terdaftar di sistem, silakan hubungi Helpdesk IT.';
                    await chat.sendMessage(
                        `❌ ${msg}\n\nJika perlu, hubungi Helpdesk IT untuk pendaftaran NIK di Koprol.`
                    );
                    // Tutup sesi (termasuk WebDriver) jika NIK tidak valid
                    this.setKoprolSession(userId, null);
                    return true;
                }

                const nama = info.nama || '-';
                const email = info.email || '-';
                const dropdowns = info.dropdowns || {
                    requestKe: [],
                    tipeRequestFor: [],
                    system: [],
                    tipeMasalah: [],
                };

                this.setKoprolSession(userId, {
                    stage: 'awaiting_hp',
                    payload: {
                        nik: info.nik || nik,
                        nama,
                        email,
                    },
                    dropdowns,
                    automation: inspector,
                });

                await chat.sendMessage(
                    `✅ NIK ditemukan di Koprol.\n\nNama Pegawai: *${nama}*\nEmail: *${email}*\n\nSekarang kirim *No. HP* yang bisa dihubungi (contoh: 0812xxxxxxx).`
                );
                inspectOk = true;
            } catch (e) {
                logger.warn('Failed to inspect public Koprol request form', e && (e.message || e));
                await chat.sendMessage(
                    '❌ Gagal menghubungi form publik Koprol untuk cek NIK. Coba lagi beberapa menit lagi atau isi langsung di website Koprol.'
                );
                this.setKoprolSession(userId, null);
            } finally {
                // Jangan auto-close di sini; WebDriver akan dipakai lagi sampai flow selesai
            }
            return true;
        }

        if (session.stage === 'awaiting_hp') {
            const hp = (text || '').trim();
            if (!hp || hp.length < 6) {
                await chat.sendMessage('⚠️ No. HP terlalu pendek. Kirim lagi No. HP yang benar, contoh: 0812xxxxxxx.');
                return true;
            }

            const payload = { ...(session.payload || {}), noHp: hp };
            const dropdowns = session.dropdowns || {
                requestKe: [],
                tipeRequestFor: [],
                system: [],
                tipeMasalah: [],
            };

            // Coba langsung isi field No. HP di form publik yang sedang terbuka
            if (session.automation && typeof session.automation.fillPublicPhoneField === 'function') {
                try {
                    await session.automation.fillPublicPhoneField(hp);
                } catch (e) {
                    try {
                        logger.warn('Failed to fill public phone field on Koprol form', e && (e.message || e));
                    } catch (_) {}
                }
            }

            // Jika Request ke masih kosong, coba baca ulang dari form publik (setelah NIK terisi)
            if ((!dropdowns.requestKe || !dropdowns.requestKe.length) && session.automation && typeof session.automation.readRequestKeOptions === 'function') {
                try {
                    const fresh = await session.automation.readRequestKeOptions();
                    if (Array.isArray(fresh) && fresh.length) {
                        dropdowns.requestKe = fresh;
                    }
                } catch (e) {
                    try {
                        logger.warn('Failed to refresh Request ke options from Koprol form', e && (e.message || e));
                    } catch (_) {}
                }
            }

            if (!dropdowns.requestKe || !dropdowns.requestKe.length) {
                // Fallback: minta user isi Request ke secara manual kalau dropdown tidak bisa dibaca
                this.setKoprolSession(userId, {
                    stage: 'awaiting_request_ke_free',
                    payload,
                    dropdowns,
                    automation: session.automation || null,
                });
                await chat.sendMessage(
                    '📌 *Request ke mana?*\nKetik nama tujuan unit/pic secara lengkap, contoh: `IT HELPDESK`.'
                );
                return true;
            }

            this.setKoprolSession(userId, {
                stage: 'awaiting_request_ke',
                payload,
                dropdowns,
                automation: session.automation || null,
            });

            const optsText = buildNumberedOptions(dropdowns.requestKe);
            await chat.sendMessage(
                `📌 *Request ke mana?*\nPilih salah satu (kirim angka saja):\n\n${optsText}`
            );
            return true;
        }

        if (session.stage === 'awaiting_request_ke_free') {
            const dropdowns = session.dropdowns || {
                requestKe: [],
                tipeRequestFor: [],
                system: [],
                tipeMasalah: [],
            };
            const value = (text || '').trim();
            if (!value) {
                await chat.sendMessage('⚠️ Isi *Request ke* tidak boleh kosong. Contoh: `IT HELPDESK`.');
                return true;
            }

            const payload = { ...(session.payload || {}), requestKe: value };

            // Langsung terapkan pilihan Request ke di form publik (jika memungkinkan)
            if (session.automation) {
                try {
                    if (typeof session.automation.selectRequestKeOnForm === 'function') {
                        await session.automation.selectRequestKeOnForm(value);
                    } else if (typeof session.automation.applyPublicDropdownSelection === 'function') {
                        await session.automation.applyPublicDropdownSelection(
                            ['Request ke', 'Request Ke'],
                            value
                        );
                    }
                } catch (e) {
                    try {
                        logger.warn('Failed to apply Request ke (free text) on Koprol form', e && (e.message || e));
                    } catch (_) {}
                }
            }

            if (!dropdowns.tipeRequestFor || !dropdowns.tipeRequestFor.length) {
                await chat.sendMessage(
                    '⚠️ Bot tidak berhasil membaca daftar *Tipe Request For* dari form Koprol. Silakan isi tiket langsung di website Koprol.'
                );
                this.setKoprolSession(userId, null);
                return true;
            }

            this.setKoprolSession(userId, {
                stage: 'awaiting_tipe_request_for',
                payload,
                dropdowns,
                automation: session.automation || null,
            });

            const optsText = buildNumberedOptions(dropdowns.tipeRequestFor);
            await chat.sendMessage(
                `📂 *Tipe Request For*\nPilih salah satu (kirim angka saja):\n\n${optsText}`
            );
            return true;
        }

        const chooseFromList = (answer, options, label) => {
            if (!options || !options.length) return null;
            const raw = (answer || '').trim();
            const num = parseInt(raw, 10);
            if (!Number.isNaN(num) && num >= 1 && num <= options.length) {
                return options[num - 1];
            }
            const lower = raw.toLowerCase();
            const match = options.find((opt) => opt.toLowerCase() === lower || opt.toLowerCase().includes(lower));
            return match || null;
        };

        if (session.stage === 'awaiting_request_ke') {
            const dropdowns = session.dropdowns || {};
            const choice = chooseFromList(text, dropdowns.requestKe || [], 'Request ke');
            if (!choice) {
                await chat.sendMessage('❌ Pilihan tidak valid. Kirim angka yang ada di daftar *Request ke*.');
                return true;
            }

            const payload = { ...(session.payload || {}), requestKe: choice };

            // Langsung terapkan pilihan Request ke di form publik
            if (session.automation) {
                try {
                    if (typeof session.automation.selectRequestKeOnForm === 'function') {
                        await session.automation.selectRequestKeOnForm(choice);
                    } else if (typeof session.automation.applyPublicDropdownSelection === 'function') {
                        await session.automation.applyPublicDropdownSelection(
                            ['Request ke', 'Request Ke'],
                            choice
                        );
                    }
                } catch (e) {
                    try {
                        logger.warn('Failed to apply Request ke choice on Koprol form', e && (e.message || e));
                    } catch (_) {}
                }
            }

            // Setelah Request ke dipilih, coba baca ulang daftar Tipe Request For dari form
            if ((!dropdowns.tipeRequestFor || !dropdowns.tipeRequestFor.length) &&
                session.automation &&
                typeof session.automation.readPublicDropdownOptionsByLabel === 'function') {
                try {
                    const fresh = await session.automation.readPublicDropdownOptionsByLabel([
                        'Tipe Request For',
                        'Type Request For',
                    ]);
                    if (Array.isArray(fresh) && fresh.length) {
                        dropdowns.tipeRequestFor = fresh;
                    }
                } catch (e) {
                    try {
                        logger.warn('Failed to refresh Tipe Request For options from Koprol form', e && (e.message || e));
                    } catch (_) {}
                }
            }

            if (!dropdowns.tipeRequestFor || !dropdowns.tipeRequestFor.length) {
                await chat.sendMessage(
                    '⚠️ Bot tidak berhasil membaca daftar *Tipe Request For* dari form Koprol. Silakan isi tiket langsung di website Koprol.'
                );
                this.setKoprolSession(userId, null);
                return true;
            }

            this.setKoprolSession(userId, {
                stage: 'awaiting_tipe_request_for',
                payload,
                dropdowns,
            });

            const optsText = buildNumberedOptions(dropdowns.tipeRequestFor);
            await chat.sendMessage(
                `📂 *Tipe Request For*\nPilih salah satu (kirim angka saja):\n\n${optsText}`
            );
            return true;
        }

        if (session.stage === 'awaiting_tipe_request_for') {
            const dropdowns = session.dropdowns || {};
            const choice = chooseFromList(text, dropdowns.tipeRequestFor || [], 'Tipe Request For');
            if (!choice) {
                await chat.sendMessage('❌ Pilihan tidak valid. Kirim angka yang ada di daftar *Tipe Request For*.');
                return true;
            }

            const payload = { ...(session.payload || {}), tipeRequestFor: choice };

            // Langsung terapkan pilihan Tipe Request For di form publik
            if (session.automation && typeof session.automation.applyPublicDropdownSelection === 'function') {
                try {
                    await session.automation.applyPublicDropdownSelection(
                        ['Tipe Request For', 'Type Request For'],
                        choice
                    );
                } catch (e) {
                    try {
                        logger.warn('Failed to apply Tipe Request For choice on Koprol form', e && (e.message || e));
                    } catch (_) {}
                }
            }

            // Setelah Tipe Request For dipilih, coba baca ulang daftar System dari form
            if ((!dropdowns.system || !dropdowns.system.length) &&
                session.automation &&
                typeof session.automation.readPublicDropdownOptionsByLabel === 'function') {
                try {
                    const fresh = await session.automation.readPublicDropdownOptionsByLabel([
                        'System',
                        'Sistem',
                    ]);
                    if (Array.isArray(fresh) && fresh.length) {
                        dropdowns.system = fresh;
                    }
                } catch (e) {
                    try {
                        logger.warn('Failed to refresh System options from Koprol form', e && (e.message || e));
                    } catch (_) {}
                }
            }

            if (!dropdowns.system || !dropdowns.system.length) {
                await chat.sendMessage(
                    '⚠️ Bot tidak berhasil membaca daftar *System* dari form Koprol. Silakan isi tiket langsung di website Koprol.'
                );
                this.setKoprolSession(userId, null);
                return true;
            }

            this.setKoprolSession(userId, {
                stage: 'awaiting_system',
                payload,
                dropdowns,
                automation: session.automation || null,
            });

            const optsText = buildNumberedOptions(dropdowns.system);
            await chat.sendMessage(
                `🖥️ *System apa yang terdampak?*\nPilih salah satu (kirim angka saja):\n\n${optsText}`
            );
            return true;
        }

        if (session.stage === 'awaiting_system') {
            const dropdowns = session.dropdowns || {};
            const choice = chooseFromList(text, dropdowns.system || [], 'System');
            if (!choice) {
                await chat.sendMessage('❌ Pilihan tidak valid. Kirim angka yang ada di daftar *System*.');
                return true;
            }

            const payload = { ...(session.payload || {}), system: choice };

            // Langsung terapkan pilihan System di form publik
            if (session.automation && typeof session.automation.applyPublicDropdownSelection === 'function') {
                try {
                    await session.automation.applyPublicDropdownSelection(
                        ['System', 'Sistem'],
                        choice
                    );
                } catch (e) {
                    try {
                        logger.warn('Failed to apply System choice on Koprol form', e && (e.message || e));
                    } catch (_) {}
                }
            }

            // Setelah System dipilih, coba baca ulang daftar Tipe Masalah dari form
            if ((!dropdowns.tipeMasalah || !dropdowns.tipeMasalah.length) &&
                session.automation &&
                typeof session.automation.readPublicDropdownOptionsByLabel === 'function') {
                try {
                    const fresh = await session.automation.readPublicDropdownOptionsByLabel([
                        'Tipe Masalah',
                        'Problem Type',
                    ]);
                    if (Array.isArray(fresh) && fresh.length) {
                        dropdowns.tipeMasalah = fresh;
                    }
                } catch (e) {
                    try {
                        logger.warn('Failed to refresh Tipe Masalah options from Koprol form', e && (e.message || e));
                    } catch (_) {}
                }
            }

            if (!dropdowns.tipeMasalah || !dropdowns.tipeMasalah.length) {
                await chat.sendMessage(
                    '⚠️ Bot tidak berhasil membaca daftar *Tipe Masalah* dari form Koprol. Silakan isi tiket langsung di website Koprol.'
                );
                this.setKoprolSession(userId, null);
                return true;
            }

            this.setKoprolSession(userId, {
                stage: 'awaiting_tipe_masalah',
                payload,
                dropdowns,
                automation: session.automation || null,
            });

            const optsText = buildNumberedOptions(dropdowns.tipeMasalah);
            await chat.sendMessage(
                `⚠️ *Tipe Masalah apa?*\nPilih salah satu (kirim angka saja):\n\n${optsText}`
            );
            return true;
        }

        if (session.stage === 'awaiting_tipe_masalah') {
            const dropdowns = session.dropdowns || {};
            const choice = chooseFromList(text, dropdowns.tipeMasalah || [], 'Tipe Masalah');
            if (!choice) {
                await chat.sendMessage('❌ Pilihan tidak valid. Kirim angka yang ada di daftar *Tipe Masalah*.');
                return true;
            }

            const payload = { ...(session.payload || {}), tipeMasalah: choice };

            // Langsung terapkan pilihan Tipe Masalah di form publik
            if (session.automation && typeof session.automation.applyPublicDropdownSelection === 'function') {
                try {
                    await session.automation.applyPublicDropdownSelection(
                        ['Tipe Masalah', 'Problem Type'],
                        choice
                    );
                } catch (e) {
                    try {
                        logger.warn('Failed to apply Tipe Masalah choice on Koprol form', e && (e.message || e));
                    } catch (_) {}
                }
            }

            this.setKoprolSession(userId, {
                stage: 'awaiting_keterangan',
                payload,
                dropdowns,
                automation: session.automation || null,
            });

            await chat.sendMessage(
                '📝 Sekarang kirim *keterangan lengkap* masalah / request kamu. Bisa beberapa kalimat ya.'
            );
            return true;
        }

        if (session.stage === 'awaiting_keterangan') {
            const desc = (text || '').trim();
            if (!desc || desc.length < 5) {
                await chat.sendMessage('⚠️ Keterangan terlalu singkat. Jelaskan minimal beberapa kata ya.');
                return true;
            }

            const payload = { ...(session.payload || {}), keterangan: desc };
            const dropdowns = session.dropdowns || {};

            this.setKoprolSession(userId, {
                stage: 'confirming',
                payload,
                dropdowns,
                automation: session.automation || null,
            });

            const p = payload;
            const summary =
                '📋 *Ringkasan Request Koprol*:\n' +
                `• NIK: *${p.nik || '-'}*\n` +
                `• Nama: *${p.nama || '-'}*\n` +
                `• Email: *${p.email || '-'}*\n` +
                `• No. HP: *${p.noHp || '-'}*\n` +
                `• Request ke: *${p.requestKe || '-'}*\n` +
                `• Tipe Request For: *${p.tipeRequestFor || '-'}*\n` +
                `• System: *${p.system || '-'}*\n` +
                `• Tipe Masalah: *${p.tipeMasalah || '-'}*\n` +
                `• Keterangan: *${p.keterangan || '-'}*\n\n` +
                'Ketik *ya* untuk submit ke Koprol, atau *batal* jika ingin membatalkan.';
            await chat.sendMessage(summary);
            return true;
        }

        if (session.stage === 'confirming') {
            const ans = (text || '').trim().toLowerCase();
            if (ans === 'ya' || ans === 'yes' || ans === 'y') {
                const payload = session.payload || {};
                // Gunakan automation yang sama jika tersedia, jika tidak baru buat baru
                let submitter = (session && session.automation) || null;
                let shouldClose = false;
                if (!submitter) {
                    submitter = new KoprolAutomation();
                    shouldClose = true;
                }
                this.setKoprolSession(userId, { ...session, stage: 'submitting' });
                try {
                    await chat.sendMessage('⚙️ Mengirim request ke Koprol (form publik)...');
                    const result = await submitter.submitPublicRequestForm(payload);
                    if (result && result.ok) {
                        const msg =
                            '✅ Request berhasil dikirim ke *Koprol Ticketing Online*.\n' +
                            (result.successMessage
                                ? `Pesan dari halaman: ${result.successMessage}`
                                : 'Silakan pantau notifikasi dari Koprol / email untuk nomor tiket.');
                        await chat.sendMessage(msg);
                    } else {
                        await chat.sendMessage(
                            '⚠️ Form publik Koprol tidak mengembalikan status yang jelas. Silakan cek langsung di website Koprol apakah request sudah masuk.'
                        );
                    }
                } catch (e) {
                    logger.warn('Failed to submit public Koprol request form', e && (e.message || e));
                    await chat.sendMessage(
                        `❌ Gagal mengirim request ke Koprol.\nPesan: ${e && (e.message || e)}\n\nSilakan coba lagi nanti atau isi langsung di website Koprol.`
                    );
                } finally {
                    // Jika automation memang milik sesi ini, tutup di sini dan bersihkan sesi
                    try {
                        if (shouldClose) {
                            await submitter.close();
                        }
                    } catch (e) {}
                    this.setKoprolSession(userId, null);
                }
                return true;
            }

            await chat.sendMessage('Ketik *ya* untuk submit ke Koprol, atau *batal* untuk membatalkan.');
            return true;
        }

        return false;
    }

    async tryHandleDoneConversation(chat, userId, text) {
        const session = doneState.get(userId);
        if (!session) {
            return false;
        }

        const lower = (text || '').trim().toLowerCase();
        if (lower === 'batal' || lower === '/batal' || lower === 'cancel') {
            doneState.clear(userId);
            await chat.sendMessage('❎ Proses Done tiket dibatalkan.');
            return true;
        }

        if (session.stage === 'awaiting_ticket') {
            const ticketId = extractTicketId(text);
            let chosenTask = null;

            if (ticketId) {
                chosenTask = (session.tasks || []).find(
                    (task) => (task.ticket || '').toUpperCase() === ticketId
                );
            } else {
                const asNumber = parseInt((text || '').trim(), 10);
                if (!Number.isNaN(asNumber) && session.tasks && session.tasks[asNumber - 1]) {
                    chosenTask = session.tasks[asNumber - 1];
                }
            }

            if (!chosenTask) {
                await chat.sendMessage(
                    `❌ Pilihan tidak valid. Kirim angka 1-${(session.tasks || []).length} atau ketik nomor tiket lengkap.`
                );
                return true;
            }

            doneState.update(userId, {
                stage: 'collecting_answers',
                selectedTicket: chosenTask.ticket,
                tasks: [],
                pendingQuestions: DONE_QUESTIONS.map((q) => ({ ...q })),
                currentQuestion: null,
                answers: {},
            });
            await chat.sendMessage(
                `🎯 Ticket *${chosenTask.ticket}* dipilih.\nBot perlu data Impact, Urgency, RCA, dan Solusi sebelum mengeksekusi Done.`
            );
            await this.sendTicketDateInfo(chat, chosenTask.ticket);
            await this.promptNextDoneQuestion(chat, userId);
            return true;
        }

        if (session.stage === 'collecting_answers') {
            await this.handleDoneAnswer(chat, userId, text);
            return true;
        }

        if (session.stage === 'executing') {
            await chat.sendMessage('⏳ Proses Done masih berjalan. Mohon tunggu...');
            return true;
        }

        return false;
    }

    async promptNextDoneQuestion(chat, userId) {
        const session = doneState.get(userId);
        if (!session) {
            return;
        }

        let question = session.currentQuestion;
        const pending = Array.isArray(session.pendingQuestions) ? [...session.pendingQuestions] : [];

        if (!question && pending.length) {
            question = pending.shift();
            doneState.update(userId, { currentQuestion: question, pendingQuestions: pending });
        }

        if (!question) {
            await chat.sendMessage(this.buildDoneSummary(session.selectedTicket, session.answers || {}));
            doneState.update(userId, { stage: 'executing' });
            await this.executeDoneTicket(chat, userId, session.selectedTicket, session.answers || {});
            return;
        }

        doneState.update(userId, { lastPromptTimestamp: Date.now() });
        await chat.sendMessage(question.prompt);
    }

    buildDoneSummary(ticketId, answers = {}) {
        const dueInfo =
            typeof answers.dueDays === 'string'
                ? answers.dueDays === '0' || answers.dueDays === '0.0' || answers.dueDays === '0.00'
                    ? 'Auto (H+1 dari Due Date lama)'
                    : `${answers.dueDays} Days`
                : '-';

        return (
            `📋 Data closing untuk *${ticketId}*:` +
            `\n• Impact: *${answers.impact || '-'}*` +
            `\n• Urgency: *${answers.urgency || '-'}*` +
            `\n• RCA: *${answers.rca || '-'}*` +
            `\n• Solusi: *${answers.solution || '-'}*` +
            `\n• Set Due Date (Days): *${dueInfo}*` +
            `\n\n✔️ Bot akan menutup tiket setelah data lengkap.`
        );
    }

    async sendTicketDateInfo(chat, ticketId) {
        const safeId = (ticketId || '').trim();
        if (!safeId) {
            return;
        }

        const infoAutomation = new KoprolAutomation();
        try {
            // Beri tahu user bahwa bot sedang mengambil data tanggal dari Koprol
            try {
                await chat.sendMessage(
                    `⏳ Mengambil *Due Date* tiket *${safeId}* dari Koprol...`
                );
            } catch (e) {}

            const info = await infoAutomation.getTicketDueDate(safeId);
            if (info && (info.assignOn || info.dueDate)) {
                const dueDate = info.dueDate || '-';
                await chat.sendMessage(
                    `ℹ️ Due Date tiket *${safeId}*: ${dueDate}`
                );
            } else {
                await chat.sendMessage(
                    `⚠️ Tidak bisa membaca *Due Date* tiket *${safeId}* dari Koprol. ` +
                    `Silakan cek langsung di form Koprol, lalu isi *Due Date Offset (Hari)* secara manual.`
                );
            }
        } catch (e) {
            try {
                logger.warn('Failed to fetch ticket date info', e && (e.message || e));
            } catch (_) {}
            await chat.sendMessage(
                `⚠️ Gagal mengambil informasi *Due Date* dari Koprol untuk tiket *${safeId}*.` +
                `\nPesan: ${e && (e.message || e)}\n\nSilakan lihat Due Date langsung di browser Koprol, lalu isi *Due Date Offset (Hari)* di sini.`
            );
        } finally {
            try {
                await infoAutomation.close();
            } catch (e) {}
        }
    }

    async handleDoneAnswer(chat, userId, text) {
        const session = doneState.get(userId);
        if (!session) {
            return;
        }

        let question = session.currentQuestion;
        if (!question) {
            await this.promptNextDoneQuestion(chat, userId);
            return;
        }

        const value = question.validate ? question.validate(text) : (text || '').trim();
        if (!value) {
            await chat.sendMessage(question.retry || 'Jawaban tidak valid. Coba lagi ya.');
            doneState.update(userId, { lastPromptTimestamp: Date.now() });
            return;
        }

        const answers = { ...(session.answers || {}), [question.key]: value };
        const pending = Array.isArray(session.pendingQuestions) ? [...session.pendingQuestions] : [];
        doneState.update(userId, { answers, currentQuestion: null, pendingQuestions: pending });

        if (!pending.length) {
            await chat.sendMessage(this.buildDoneSummary(session.selectedTicket, answers));
            doneState.update(userId, { stage: 'executing' });
            await this.executeDoneTicket(chat, userId, session.selectedTicket, answers);
        } else {
            await this.promptNextDoneQuestion(chat, userId);
        }
    }

    async executeDoneTicket(chat, userId, ticketId, answers) {
        if (!ticketId) {
            doneState.clear(userId);
            await chat.sendMessage('❌ Ticket belum dipilih. Silakan ketik *done* lagi.');
            return;
        }

        await chat.sendMessage(
            `⚙️ Menyelesaikan tiket *${ticketId}*...\nImpact: ${answers.impact || '-'}\nUrgency: ${answers.urgency || '-'}`
        );

        const closer = new KoprolAutomation();
        try {
            const result = await closer.completeOutstandingTicket(ticketId, answers);
            await chat.sendMessage(`✅ Ticket *${ticketId}* berhasil di-Done.`);
            const cacheKey = this.getOutstandingCacheKey(userId, chat);
            breakState.removeOutstandingTicket(cacheKey, ticketId);

            if (result && result.statusUrl && result.customerPhone) {
                await this.startTicketRatingFlow(ticketId, result.statusUrl, result.customerPhone);
            }
        } catch (error) {
            logger.error('Failed to complete ticket', error);
            await chat.sendMessage(
                `❌ Gagal menyelesaikan tiket *${ticketId}*.\nPesan: ${error.message || error}\n\nSilakan coba lagi dengan mengetik *done*.`
            );
        } finally {
            doneState.clear(userId);
            // Jangan langsung tutup browser agar bisa inspeksi halaman (permintaan user)
            try {
                await closer.close(false);
            } catch (e) {}
        }
    }

    async startTicketRatingFlow(ticketId, statusUrl, customerPhoneRaw) {
        const phone = (customerPhoneRaw || '').trim();
        if (!phone || !statusUrl) {
            return;
        }

        const jid = normalizePhoneToJid(phone);
        if (!jid) {
            return;
        }

        const sessionPayload = {
            stage: 'awaiting_rating',
            ticketId,
            statusUrl,
            customerPhone: phone,
            startedAt: Date.now(),
            lastPromptAt: Date.now(),
            defaultRating: 5,
            defaultAction: 'done',
            defaultComment: 'done',
        };
        this.ticketRatingSessions.set(jid, sessionPayload);

        const msg =
            `📨 Ticket *${ticketId}* sudah diselesaikan oleh IT Helpdesk.\n` +
            `Mohon bantuannya untuk memberikan *rating layanan 1-5 bintang* dan *status* tiket.\n\n` +
            `Balas dengan format: *<rating> <status>*\n` +
            `- Contoh: *5 done* (jika sudah sesuai)\n` +
            `- Contoh: *2 return* (jika ingin dikembalikan/masih bermasalah)\n\n` +
            `Jika tidak ada balasan dalam ${Math.round(TICKET_RATING_TIMEOUT_MS / 60000)} menit, ` +
            `sistem akan otomatis mengisi rating *5 bintang* dengan status *done*.`;

        try {
            await this.client.sendMessage(jid, msg);
        } catch (e) {
            logger.warn('Failed to send ticket rating request', e.message || e);
            this.ticketRatingSessions.delete(jid);
        }
    }

    async tryHandleTicketRatingConversation(chat, userId, text) {
        const session = this.getTicketRatingSession(userId);
        if (!session || session.stage !== 'awaiting_rating') {
            return false;
        }

        const lower = (text || '').trim().toLowerCase();
        if (!lower) {
            await chat.sendMessage('⚠️ Format rating tidak dikenali. Contoh: *5 done* atau *3 return*.');
            return true;
        }

        const parts = lower.split(/\s+/).filter(Boolean);
        const ratingPart = parts[0];
        const ratingNum = parseInt(ratingPart, 10);
        if (Number.isNaN(ratingNum) || ratingNum < 1 || ratingNum > 5) {
            await chat.sendMessage('⚠️ Rating harus angka *1-5*. Contoh: *5 done* atau *3 return*.');
            return true;
        }

        let action = 'done';
        if (parts[1]) {
            const act = parts[1];
            if (act.includes('return')) {
                action = 'return';
            } else if (act.includes('done')) {
                action = 'done';
            }
        }

        const extraComment = parts.slice(2).join(' ').trim();
        const commentBase = action === 'return' ? 'return ticket' : 'done ticket';
        const comment = extraComment ? `${commentBase} - ${extraComment}` : commentBase;

        const automation = new KoprolAutomation();
        try {
            await automation.submitTicketRating({
                statusUrl: session.statusUrl,
                rating: ratingNum,
                comment,
                action,
            });

            await chat.sendMessage(
                `✅ Terima kasih, rating *${ratingNum} bintang* dengan status *${action}* ` +
                    `sudah dikirim untuk ticket *${session.ticketId}*.`
            );
        } catch (e) {
            logger.error('Failed to submit ticket rating', e.message || e);
            await chat.sendMessage(
                `❌ Gagal mengirim rating untuk ticket *${session.ticketId}*. ` +
                    `Pesan: ${e && (e.message || e)}`
            );
        } finally {
            this.setTicketRatingSession(userId, null);
            try {
                await automation.close();
            } catch (e) {}
        }

        return true;
    }

    startReminderLoop() {
        if (this.reminderInterval) {
            return;
        }
        this.reminderInterval = setInterval(() => {
            this.checkAssignmentReminders().catch((e) => {
                logger.warn('Error in assignment reminder loop', e.message || e);
            });
            this.checkTicketRatingTimeouts().catch((e) => {
                logger.warn('Error in ticket rating reminder loop', e.message || e);
            });
        }, 60000);
    }

    async checkAssignmentReminders() {
        const now = Date.now();
        const idleMs = 2 * 60 * 1000;
        const maxIdleMs = 30 * 60 * 1000;

        const tickets = assignmentState.getAllOpenTickets();
        for (const { ticketId, state } of tickets) {
            if (!state) continue;
            if (state.stage !== 'collecting_answers') continue;
            if (!state.lastPromptTimestamp) continue;

            const sincePrompt = now - state.lastPromptTimestamp;
            if (sincePrompt < idleMs) continue;

            if (sincePrompt > maxIdleMs) {
                assignmentState.reset(ticketId);
                continue;
            }

            if (!state.chatId) continue;

            if (state.lastReminderTimestamp && now - state.lastReminderTimestamp < idleMs) {
                continue;
            }

            try {
                await this.client.sendMessage(
                    state.chatId,
                    '⏰ Masih ingin melanjutkan assign tiket ini? Balas pertanyaan terakhir, atau ketik *batal* untuk membatalkan.'
                );
                assignmentState.setLastReminder(ticketId, now);
                assignmentState.incrementReminderCount(ticketId);
            } catch (e) {
                logger.warn('Failed to send assignment reminder', e.message || e);
            }
        }
    }

    async checkTicketRatingTimeouts() {
        const now = Date.now();

        for (const [userId, session] of this.ticketRatingSessions.entries()) {
            if (!session || session.stage !== 'awaiting_rating') {
                continue;
            }

            if (!session.lastPromptAt || !session.statusUrl) {
                continue;
            }

            const elapsed = now - session.lastPromptAt;
            if (elapsed < TICKET_RATING_TIMEOUT_MS) {
                continue;
            }

            const automation = new KoprolAutomation();
            try {
                await automation.submitTicketRating({
                    statusUrl: session.statusUrl,
                    rating: session.defaultRating || 5,
                    comment: session.defaultComment || 'done',
                    action: session.defaultAction || 'done',
                });

                const jid = userId;
                try {
                    await this.client.sendMessage(
                        jid,
                        `⏰ Tidak ada balasan rating dalam waktu yang ditentukan. ` +
                            `Sistem otomatis mengisi rating *${session.defaultRating || 5} bintang* ` +
                            `dengan status *${session.defaultAction || 'done'}* untuk ticket *${
                                session.ticketId || '-'
                            }*.`
                    );
                } catch (e) {}
            } catch (e) {
                logger.warn('Failed to auto-submit ticket rating', e.message || e);
            } finally {
                this.ticketRatingSessions.delete(userId);
                try {
                    await automation.close();
                } catch (e) {}
            }
        }
    }

    async tryExtractTicketIdFromImage(message) {
        if (!message || !message.hasMedia) {
            return null;
        }

        // Don't rely on message.type; use mimetype (some clients send images as document)

        let media;
        try {
            media = await message.downloadMedia();
        } catch (e) {
            logger.warn('Failed to download media for OCR', e.message || e);
            return null;
        }
        if (!media || !media.data) {
            return null;
        }
        if (media.mimetype && !String(media.mimetype).toLowerCase().startsWith('image/')) {
            return null;
        }

        try {
            const buf = Buffer.from(media.data, 'base64');
            const result = await Tesseract.recognize(buf, 'eng', {
                logger: () => {},
            });
            const ocrText = (result && result.data && result.data.text) ? result.data.text : '';
            const ticketId = extractTicketId(ocrText || '') || extractTicketIdLoose(ocrText || '');
            if (ticketId) {
                logger.info(`OCR extracted ticketId: ${ticketId}`);
                return ticketId;
            }
        } catch (e) {
            logger.warn('OCR processing failed (non-critical)', e.message || e);
        }
        return null;
    }

    async handleMessage(message) {
        try {
            if (!message) {
                return;
            }

            const chat = await message.getChat().catch(() => null);
            if (!chat) {
                return;
            }

            const rawBody = (message.body || '').trim();
            let text = rawBody;
            if (!text) {
                const ticketFromImage = await this.tryExtractTicketIdFromImage(message);
                if (ticketFromImage) {
                    text = ticketFromImage;
                } else if (message.hasMedia) {
                    await chat.sendMessage(
                        '🖼️ Aku menerima gambar, tapi belum berhasil membaca nomor tiketnya.\n\nTolong ketik nomor tiketnya ya (contoh: RF/TD/25/12/03171).'
                    );
                    return;
                }
            }
            if (!text) {
                return;
            }

            let contact, userId;
            try {
                contact = await message.getContact();
                userId = contact?.id?._serialized || message.from;
            } catch (e) {
                userId = message.from;
                contact = { pushname: 'User', number: message.from };
            }

            logger.info(`Message from ${contact.pushname || contact.number || 'Unknown'}: ${text}`);

            const lowerText = text.toLowerCase();

            // 0) Flow input tiket Koprol (form publik) jika sedang berjalan
            if (await this.tryHandleKoprolRequestConversation(chat, userId, text)) {
                return;
            }

            // 1) Jika user sedang dalam flow kirim kredensial outstanding, proses dulu di sini
            if (await this.tryHandleOutstandingCredentialConversation(chat, userId, text)) {
                return;
            }

            // 1a) Flow rating ticket ke user akhir
            if (await this.tryHandleTicketRatingConversation(chat, userId, text)) {
                return;
            }

            // 2) Conversational flows lain (done / end break / break / assignment)
            if (await this.tryHandleDoneConversation(chat, userId, text)) {
                return;
            }

            if (await this.tryHandleEndBreakConversation(chat, userId, text)) {
                return;
            }

            if (await this.tryHandleBreakConversation(chat, userId, text)) {
                return;
            }

            if (await this.tryHandleAssignmentConversation(chat, userId, text)) {
                return;
            }

            // 3) AI Agent routing (jika diaktifkan)
            if (config.agent.enabled) {
                const decision = await this.agent.decide(text);
                logger.info(`Agent decision: ${JSON.stringify(decision)}`);

                if (decision.intent === 'rfa' && decision.ticketId) {
                    await this.handleTicketInput(chat, userId, decision.ticketId);
                    return;
                }
                if (decision.intent === 'status') {
                    await this.handleStatusCommand(chat);
                    return;
                }
                if (decision.intent === 'done_ticket') {
                    await this.handleDoneCommand(chat, userId, text);
                    return;
                }
                if (decision.intent === 'end_break') {
                    await this.handleEndBreakCommand(chat, userId, text);
                    return;
                }
                if (decision.intent === 'break') {
                    await this.handleBreakCommand(chat, userId, text);
                    return;
                }
                if (decision.intent === 'outstanding') {
                    const key = this.getOutstandingCacheKey(userId, chat);
                    const savedCreds = key ? this.outstandingCredentials.get(key) : null;
                    if (!savedCreds) {
                        await this.startOutstandingCredentialFlow(chat, userId);
                    } else {
                        await this.handleOutstandingCommand(chat, userId, '', { credentials: savedCreds });
                    }
                    return;
                }
                if (decision.intent === 'menu') {
                    await this.sendMainMenu(chat);
                    return;
                }
                if (decision.intent === 'help') {
                    await this.handleHelpCommand(chat);
                    return;
                }
            }

            // 4) Fallback routing berbasis keyword jika agent tidak aktif / tidak mengenali
            if (text.startsWith('/claim')) {
                await this.handleClaimCommand(message, chat, userId, text);
            } else if (lowerText === 'koprol' || text === '/koprol') {
                await this.startKoprolRequestFlow(chat, userId);
            } else if (lowerText === 'status' || text === '/status' || text === '📊 Cek Status') {
                await this.handleStatusCommand(chat);
            } else if (
                lowerText.includes('end break') ||
                lowerText.includes('resume break') ||
                lowerText.includes('lanjut break') ||
                lowerText.includes('selesai break') ||
                text === '▶️ End Break'
            ) {
                await this.handleEndBreakCommand(chat, userId, text);
            } else if (lowerText.includes('break') || text === '⏸ Break Ticket') {
                await this.handleBreakCommand(chat, userId, text);
            } else if (
                lowerText.includes('outstanding') ||
                lowerText.includes('cek outstanding') ||
                text === '📋 Outstanding'
            ) {
                const key = this.getOutstandingCacheKey(userId, chat);
                const savedCreds = key ? this.outstandingCredentials.get(key) : null;
                if (!savedCreds) {
                    await this.startOutstandingCredentialFlow(chat, userId);
                } else {
                    await this.handleOutstandingCommand(chat, userId, '', { credentials: savedCreds });
                }
            } else if (
                lowerText === 'menu' ||
                text === '/menu' ||
                text === '/start' ||
                lowerText === 'help' ||
                text === '/help' ||
                text === '📋 Menu Utama'
            ) {
                await this.sendMainMenu(chat);
            } else if (!text.startsWith('/') && text.length > 3) {
                // Jika bukan perintah khusus, coba treat sebagai input nomor tiket
                await this.handleTicketInput(chat, userId, text);
            }
        } catch (error) {
            logger.warn('Non-critical error handling message:', error.message);
        }
    }

    async handleClaimCommand(message, chat, userId, text) {
        const parts = (text || '').trim().split(/\s+/);
        const ticketIdentifier = extractTicketId(parts.slice(1).join(' '));
        if (!ticketIdentifier) {
            await chat.sendMessage('❌ Format salah!\n\nGunakan: /claim RF/BD/25/11/01552');
            return;
        }

        await this.startTicketWorkflow(chat, userId, ticketIdentifier);
    }

    async handleStatusCommand(chat) {
        const status = ticketQueue.getStatus();
        
        let statusMsg = '📊 *Status Bot*\n\n';
        statusMsg += `🔄 Processing: ${status.processing ? 'Ya' : 'Tidak'}\n`;
        statusMsg += `📋 Antrian: ${status.queueLength} tiket\n`;
        
        if (status.currentTask) {
            statusMsg += `⚙️ Sedang proses: ${status.currentTask}`;
        }

        await chat.sendMessage(statusMsg);
    }

    async sendMainMenu(chat) {
        const menuMsg = `🤖 *Koprol Ticket Dispatcher*

┌────────────────────────┐
│  *MENU UTAMA*        │
└────────────────────────┘

📤 *1. RFA Tiket*
• Ketik: *claim* lalu kirim nomor tiket
• ATAU kirim langsung nomor tiket: RF/BD/25/11/01552

📊 *2. Cek Status*
Ketik: *status*

ℹ️ *3. Bantuan*
Ketik: *help*

────────────────────────
🚀 *Contoh Langsung:*
RF/BD/25/11/01552

⚙️ _Bot RFA Dispatcher v1.0_`;
        
        await chat.sendMessage(menuMsg);
        logger.info('Text menu sent successfully');
    }

    async promptClaimTicket(chat) {
        const promptMsg = `📤 *RFA Tiket*\n\nSilakan kirim nomor tiket yang ingin di-RFA (Request for Approval).\n\n*Contoh:*\n• RF/BD/25/11/01552\n• RF/PS/25/11/10829\n• RF/ST/25/11/01453\n\n💡 Bot akan otomatis:\n1. Cari tiket di Koprol\n2. Buka detail tiket\n3. Klik tombol RFA\n4. Kirim notifikasi hasil\n\nAtau gunakan: /claim RF/BD/25/11/01552`;
        
        await chat.sendMessage(promptMsg);
    }

    async handleTicketInput(chat, userId, rawText) {
        const ticketIdentifier = extractTicketId(rawText);
        if (!ticketIdentifier) {
            await chat.sendMessage('❌ Format nomor tiket tidak dikenali.\n\nKirim contoh: RF/BD/25/11/01552');
            return;
        }

        await this.startTicketWorkflow(chat, userId, ticketIdentifier);
    }

    async tryHandleAssignmentConversation(chat, userId, text) {
        const ticketId = assignmentState.getTicketForUser(userId);
        if (!ticketId) {
            return false;
        }

        const lower = text.trim().toLowerCase();
        if (lower === 'batal' || lower === 'cancel' || text === '/cancel') {
            assignmentState.reset(ticketId);
            await chat.sendMessage('❎ Proses assignment dibatalkan. Kirim nomor tiket lagi jika ingin memulai ulang.');
            return true;
        }

        const stage = assignmentState.getStage(ticketId);
        if (stage === 'collecting_answers') {
            await this.handleAssignmentAnswer(chat, userId, ticketId, text);
            return true;
        }

        if (stage === 'queued' || stage === 'processing') {
            await chat.sendMessage(`⏳ Tiket *${ticketId}* sedang diproses. Mohon tunggu notifikasi selesai.`);
            return true;
        }

        return false;
    }

    async startTicketWorkflow(chat, userId, ticketIdentifier) {
        const existingTicket = assignmentState.getTicketForUser(userId);
        if (existingTicket && existingTicket !== ticketIdentifier) {
            await chat.sendMessage(`⚠️ Kamu masih mengisi tiket *${existingTicket}*.\nBalas pertanyaan sebelumnya atau ketik *batal* untuk membatalkan.`);
            return;
        }

        const existingStage = existingTicket === ticketIdentifier ? assignmentState.getStage(ticketIdentifier) : null;
        if (existingStage && existingStage !== 'idle') {
            await chat.sendMessage(`✏️ Jawab pertanyaan yang sudah dikirim untuk tiket *${ticketIdentifier}* atau ketik *batal* untuk mulai ulang.`);
            return;
        }

        const ownerCtx = assignmentState.getUserContext(ticketIdentifier) || {};
        if (ownerCtx.userId && ownerCtx.userId !== userId) {
            await chat.sendMessage('⚠️ Tiket ini sedang diproses oleh user lain. Silakan coba tiket lain.');
            return;
        }

        assignmentState.reset(ticketIdentifier);
        assignmentState.ensure(ticketIdentifier);
        assignmentState.setUserContext(ticketIdentifier, userId, chat?.id?._serialized || chat?.id || null);
        assignmentState.setStage(ticketIdentifier, 'collecting_answers');
        assignmentState.setPendingQuestions(ticketIdentifier, ASSIGNMENT_QUESTIONS.map((q) => ({ ...q })));
        assignmentState.setCurrentQuestion(ticketIdentifier, null);
        assignmentState.setLastPrompt(ticketIdentifier);

        await chat.sendMessage(`✅ Tiket *${ticketIdentifier}* diterima.\nBot akan analisa dan assign otomatis setelah kamu menjawab 3 pertanyaan singkat (bisa ketik *batal* untuk membatalkan).`);
        await this.promptNextAssignmentQuestion(chat, ticketIdentifier);
    }

    async promptNextAssignmentQuestion(chat, ticketIdentifier) {
        let question = assignmentState.getCurrentQuestion(ticketIdentifier);
        if (!question) {
            question = assignmentState.shiftQuestion(ticketIdentifier);
            assignmentState.setCurrentQuestion(ticketIdentifier, question || null);
        }

        if (!question) {
            await this.completeAssignmentAnswers(chat, ticketIdentifier);
            return;
        }

        assignmentState.setLastPrompt(ticketIdentifier);
        await chat.sendMessage(question.prompt);
    }

    async handleAssignmentAnswer(chat, userId, ticketIdentifier, text) {
        let question = assignmentState.getCurrentQuestion(ticketIdentifier);
        if (!question) {
            await this.promptNextAssignmentQuestion(chat, ticketIdentifier);
            return;
        }

        const value = question.validate ? question.validate(text) : (text || '').trim();
        if (!value) {
            await chat.sendMessage(question.retry || 'Jawaban tidak valid. Coba lagi ya.');
            assignmentState.setLastPrompt(ticketIdentifier);
            return;
        }

        assignmentState.recordAnswer(ticketIdentifier, question.key, value);
        assignmentState.setCurrentQuestion(ticketIdentifier, null);

        if (assignmentState.ensure(ticketIdentifier).pendingQuestions.length === 0) {
            await this.completeAssignmentAnswers(chat, ticketIdentifier);
        } else {
            await this.promptNextAssignmentQuestion(chat, ticketIdentifier);
        }
    }

    async completeAssignmentAnswers(chat, ticketIdentifier) {
        assignmentState.setStage(ticketIdentifier, 'ready_to_queue');
        const answers = assignmentState.getAnswers(ticketIdentifier);
        await chat.sendMessage(this.buildAssignmentSummary(ticketIdentifier, answers));
        await this.enqueueTicketTask(chat, assignmentState.getUserContext(ticketIdentifier).userId, ticketIdentifier, answers);
    }

    buildAssignmentSummary(ticketIdentifier, answers = {}) {
        const pic = answers.pic || '-';
        const impact = answers.impact || '-';
        const urgency = answers.urgency || '-';
        return `📋 Data assign untuk *${ticketIdentifier}*:\n• PIC: *${pic}*\n• Impact: *${impact}*\n• Urgency: *${urgency}*\n\n⏳ Bot memulai proses assign di Koprol. Mohon tunggu...`;
    }

    async enqueueTicketTask(chat, userId, ticketIdentifier, answers) {
        assignmentState.setStage(ticketIdentifier, 'queued');
        const payload = { ...answers };

        const task = {
            ticketId: ticketIdentifier,
            userId,
            execute: async () => {
                assignmentState.setStage(ticketIdentifier, 'processing');
                const result = await this.koprolBot.claimTicket(ticketIdentifier, payload);
                assignmentState.reset(ticketIdentifier);
                await chat.sendMessage(result.message);

                try {
                    if (result && result.started) {
                        const picName = (answers.pic || '').trim();
                        const picPhone =
                            (picName && config.picPhones && config.picPhones[picName]) || '';

                        const phones = [
                            (config.notification && config.notification.khatarPhone) || '',
                            (config.admin && config.admin.phone) || '',
                            picPhone,
                        ].filter(Boolean);

                        const jids = Array.from(new Set(phones.map(normalizePhoneToJid).filter(Boolean)));
                        if (jids.length) {
                            const notifMsg = `📣 *Notifikasi Ticket Assign*\n\nTiket: *${ticketIdentifier}*\nPIC: *${answers.pic || '-'}*\nImpact: *${answers.impact || '-'}*\nUrgency: *${answers.urgency || '-'}*\n\nStatus: Berhasil di-RFA, di-Assign, dan di-Start untuk Teams IT HELPDESK SS.`;
                            for (const jid of jids) {
                                await this.client.sendMessage(jid, notifMsg);
                            }
                        }
                    }
                } catch (e) {
                    logger.warn('Failed to send ticket assignment notification', e.message || e);
                }
                setTimeout(async () => {
                    await this.sendMainMenu(chat);
                }, 2000);
            },
            onError: async (error) => {
                assignmentState.reset(ticketIdentifier);
                await chat.sendMessage(`❌ Terjadi kesalahan memproses tiket *${ticketIdentifier}*.\nPesan: ${error.message}`);
            }
        };

        ticketQueue.add(task);

        const status = ticketQueue.getStatus();
        if (status.queueLength > 0) {
            await chat.sendMessage(`📋 Antrian: ${status.queueLength} tiket\n⏱️ Estimasi: ~${status.queueLength * 10} detik`);
        }
    }

    async handleHelpCommand(chat) {
        const helpMsg = `🤖 *WhatsApp Bot - Koprol RFA Dispatcher*\n\n📝 *Cara Penggunaan:*\n\n*1. RFA Tiket (Step by Step)*\n• Ketik: *claim*\n• Bot akan minta nomor tiket\n• Kirim nomor tiket (contoh: RF/BD/25/11/01552)\n\n*2. RFA Tiket (Langsung)*\n• Kirim langsung nomor tiket: \n  RF/BD/25/11/01552\n• Atau gunakan command: \n  \`\`\`/claim RF/BD/25/11/01552\`\`\`\n\n*3. Cek Status Antrian*\nKetik: *status*\n\n*4. Menu Utama*\nKetik: *menu*\n\n────────────────────────\n🤖 *Apa yang Bot Lakukan?*\n\n1️⃣ Login ke Koprol\n2️⃣ Cari tiket di Request Detail (Kanban)\n3️⃣ Buka detail tiket\n4️⃣ Klik tombol RFA\n5️⃣ Kirim notifikasi hasil\n\n💡 *Tips:*\n- Bot memproses tiket satu per satu\n- Notifikasi otomatis setelah berhasil\n- Bisa digunakan multiple user\n\n⚙️ *Bot RFA Dispatcher v1.0*`;

        await chat.sendMessage(helpMsg);
        
        setTimeout(async () => {
            await this.sendMainMenu(chat);
        }, 2000);
    }

    async start() {
        try {
            logger.info('Starting WhatsApp Bot...');
            await this.client.initialize();
        } catch (error) {
            logger.error('Failed to start WhatsApp Bot', error);
            throw error;
        }
    }

    async stop() {
        try {
            await this.koprolBot.close();
            await this.client.destroy();
            logger.info('WhatsApp Bot stopped');
        } catch (error) {
            logger.error('Error stopping bot', error);
        }
    }
}

module.exports = WhatsAppBot;

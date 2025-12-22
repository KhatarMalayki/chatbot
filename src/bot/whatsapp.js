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
    }
];

const PIC_LIST_TEXT = PIC_OPTIONS.map((name, idx) => `${idx + 1}. ${name}`).join('\n');
const OUTSTANDING_CACHE_TTL = 2 * 60 * 1000; // 2 menit

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
        this.setupEventHandlers();
        this.startReminderLoop();
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
            const status = [task.state || '', task.clock || ''].filter(Boolean).join(' • ');
            if (status) chunks.push(status);
            return chunks.join('\n');
        });

        return `📋 *Outstanding Task - ${picName || 'PIC'}*\n\n${lines.join('\n\n')}`;
    }

    getOutstandingCacheKey(userId, chat) {
        return userId || chat?.id?._serialized || chat?.id || null;
    }

    async handleOutstandingCommand(chat, userId = '', picNameOverride = '', options = {}) {
        const picName = picNameOverride || (config.admin && config.admin.picName) || 'MOHAMAD KHATAR MALAYKI';
        const cacheKey = this.getOutstandingCacheKey(userId, chat);
        const cachedOutstanding = cacheKey ? breakState.getOutstanding(cacheKey) : null;
        
        await chat.sendMessage(`⏳ Sedang mengambil data Outstanding Task untuk *${picName}*...`);

        const checker = new KoprolAutomation();
        try {
            const tasks = await checker.fetchOutstandingTasks(picName, 10);
            const message = this.buildOutstandingMessage(tasks, picName);
            await chat.sendMessage(message);

            if (cacheKey) {
                breakState.setOutstanding(cacheKey, { tasks, picName });
            }
        } catch (err) {
            logger.error('Failed to fetch outstanding tasks', err);
            if (cachedOutstanding && Array.isArray(cachedOutstanding.tasks)) {
                const fallback = this.buildOutstandingMessage(cachedOutstanding.tasks, picName);
                await chat.sendMessage(
                    `⚠️ Refresh data gagal (${err.message || err}). Menampilkan data terakhir yang tersimpan.\n\n${fallback}`
                );
            } else {
                await chat.sendMessage(`❌ Gagal mengambil Outstanding Task.\nPesan: ${err.message || err}`);
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
            Date.now() - (cachedOutstanding.fetchedAt || 0) <= OUTSTANDING_CACHE_TTL;

        let tasks = [];
        if (isCacheFresh) {
            tasks = cachedOutstanding.tasks;
            await chat.sendMessage('♻️ Menggunakan data Outstanding yang baru saja kamu lihat (≤2 menit).');
        } else {
            await chat.sendMessage(`⏳ Mengecek tiket *Break* untuk *${picName}*...`);
            const checker = new KoprolAutomation();
            try {
                tasks = await checker.fetchOutstandingTasks(picName, 15);
                if (cacheKey) {
                    breakState.setOutstanding(cacheKey, { tasks, picName });
                }
            } catch (error) {
                logger.error('Failed to fetch tasks for end break command', error);
                await chat.sendMessage(`❌ Gagal mengambil daftar Outstanding Task.\nPesan: ${error.message || error}`);
                return;
            } finally {
                try {
                    await checker.close();
                } catch (e) {}
            }
        }

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
            Date.now() - (cachedOutstanding.fetchedAt || 0) <= OUTSTANDING_CACHE_TTL;

        let tasks = [];
        let usedCache = false;

        if (isCacheFresh) {
            tasks = cachedOutstanding.tasks;
            usedCache = true;
            await chat.sendMessage('♻️ Menggunakan data Outstanding yang baru saja kamu lihat (≤2 menit).');
        } else {
            await chat.sendMessage(`⏳ Mengecek tiket *On Progress* untuk *${picName}*...`);
            const checker = new KoprolAutomation();
            try {
                tasks = await checker.fetchOutstandingTasks(picName, 15);
                if (cacheKey) {
                    breakState.setOutstanding(cacheKey, { tasks, picName });
                }
            } catch (error) {
                logger.error('Failed to fetch tasks for break command', error);
                await chat.sendMessage(`❌ Gagal mengambil daftar Outstanding Task.\nPesan: ${error.message || error}`);
                return;
            } finally {
                try {
                    await checker.close();
                } catch (e) {}
            }
        }

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

        let tasks = [];
        await chat.sendMessage(`⏳ Mengecek tiket *On Progress* untuk *${picName}* (tanpa cache)...`);
        const checker = new KoprolAutomation();
        try {
            tasks = await checker.fetchOutstandingTasks(picName, 15);
            const cacheKey = this.getOutstandingCacheKey(userId, chat);
            if (cacheKey) {
                // Boleh tetap menyegarkan cache untuk perintah lain, tetapi DONE tidak memakai cache lama.
                breakState.setOutstanding(cacheKey, { tasks, picName });
            }
        } catch (error) {
            logger.error('Failed to fetch tasks for done command', error);
            await chat.sendMessage(`❌ Gagal mengambil daftar Outstanding Task.\nPesan: ${error.message || error}`);
            return;
        } finally {
            try {
                await checker.close();
            } catch (e) {}
        }

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
        return `📋 Data closing untuk *${ticketId}*:\n• Impact: *${answers.impact || '-'}*\n• Urgency: *${answers.urgency || '-'}*\n• RCA: *${answers.rca || '-'}*\n• Solusi: *${answers.solution || '-'}*\n\n✔️ Bot akan menutup tiket setelah data lengkap.`;
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
            await closer.completeOutstandingTicket(ticketId, answers);
            await chat.sendMessage(`✅ Ticket *${ticketId}* berhasil di-Done.`);
            const cacheKey = this.getOutstandingCacheKey(userId, chat);
            breakState.removeOutstandingTicket(cacheKey, ticketId);
        } catch (error) {
            logger.error('Failed to complete ticket', error);
            await chat.sendMessage(
                `❌ Gagal menyelesaikan tiket *${ticketId}*.\nPesan: ${error.message || error}\n\nSilakan coba lagi dengan mengetik *done*.`
            );
        } finally {
            doneState.clear(userId);
            // Jangan langsung tutup browser agar bisa inspeksi halaman (permintaan user)
        }
    }

    setupEventHandlers() {
        this.client.on('qr', (qr) => {
            logger.info('QR Code received. Scan dengan WhatsApp Anda:');
            qrcode.generate(qr, { small: true });
        });

        this.client.on('ready', async () => {
            logger.info('✅ WhatsApp Bot siap digunakan!');
            logger.info('💡 Kirim /menu ke bot untuk memulai');
            
            try {
                await this.koprolBot.initialize();
                logger.info('✅ Koprol automation initialized');
            } catch (error) {
                logger.error('Failed to initialize Koprol automation', error);
            }
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

        this.client.on('message', async (message) => {
            await this.handleMessage(message);
        });

        this.client.on('message_create', async (message) => {
            if (message.fromMe && message.body.startsWith('!')) {
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

        this.client.pupBrowser?.on('error', (error) => {
            logger.warn('Browser error (non-critical):', error.message);
        });

        this.client.pupPage?.on('error', (error) => {
            logger.warn('Page error (non-critical):', error.message);
        });
    }

    startReminderLoop() {
        if (this.reminderInterval) {
            return;
        }
        this.reminderInterval = setInterval(() => {
            this.checkAssignmentReminders().catch((e) => {
                logger.warn('Error in assignment reminder loop', e.message || e);
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

            // AI Agent routing first (if enabled)
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
                    await this.handleOutstandingCommand(chat);
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
                if (decision.intent === 'prompt_ticket') {
                    await this.promptClaimTicket(chat);
                    return;
                }
            }

            if (text.startsWith('/claim')) {
                await this.handleClaimCommand(message, chat, userId, text);
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
            } else if (
                lowerText.includes('done') ||
                lowerText.includes('selesai tiket') ||
                text === '✅ Done Ticket'
            ) {
                await this.handleDoneCommand(chat, userId, text);
            } else if (lowerText.includes('break') || text === '⏸ Break Ticket') {
                await this.handleBreakCommand(chat, userId, text);
            } else if (lowerText.includes('outstanding') || lowerText.includes('cek outstanding') || text === '📋 Outstanding') {
                await this.handleOutstandingCommand(chat);
            } else if (lowerText === 'menu' || text === '/menu' || text === '/start' || lowerText === 'help' || text === '/help' || text === '📋 Menu Utama') {
                await this.sendMainMenu(chat);
            } else if (lowerText === 'claim' || text === '🎫 Claim Tiket') {
                await this.promptClaimTicket(chat);
            } else if (text === 'ℹ️ Bantuan') {
                await this.handleHelpCommand(chat);
            } else if (!text.startsWith('/') && text.length > 3) {
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
                        const phones = [
                            (config.notification && config.notification.khatarPhone) || '',
                            (config.admin && config.admin.phone) || ''
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
                    logger.warn('Failed to send notification to Pak Khatar', e.message || e);
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

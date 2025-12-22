# WhatsApp Bot - Koprol Ticket Dispatcher

Bot WhatsApp gratis untuk mengambil tiket dari koprol.tunasgroup.com secara otomatis.

## Fitur

- ✅ **Interactive Buttons**: Menu dengan tombol interaktif yang mudah digunakan
- ✅ **Claim Tiket Otomatis**: Kirim nomor/nama tiket via WhatsApp, bot akan claim ke outstanding user
- ✅ **Queue System**: Mengelola antrian request agar tidak overload
- ✅ **Multi-user Support**: Bisa digunakan beberapa user sekaligus
- ✅ **Logging**: Tracking semua aktivitas bot

## Tech Stack

- **WhatsApp Interface**: whatsapp-web.js (gratis, tidak perlu API berbayar)
- **Browser Automation**: Selenium WebDriver
- **Runtime**: Node.js
- **Queue**: Internal JavaScript Queue

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Setup Environment Variables

Copy `.env.example` ke `.env` dan isi kredensial Koprol:

```bash
cp .env.example .env
```

Edit `.env`:

```
KOPROL_URL=https://koprol.tunasgroup.com
KOPROL_USERNAME=username_anda
KOPROL_PASSWORD=password_anda
ADMIN_PHONE=628123456789
```

### 3. Install Chrome/Chromium Driver

Download ChromeDriver sesuai versi Chrome Anda:
https://chromedriver.chromium.org/downloads

Atau install via npm:

```bash
npm install -g chromedriver
```

### 4. Jalankan Bot

```bash
npm start
```

Scan QR Code yang muncul di terminal dengan WhatsApp Anda.

## Cara Pakai

### Dengan Interactive Buttons (Recommended)

1. **Mulai Bot**: Kirim `/menu` atau `/start`
2. **Pilih Menu**: Klik tombol yang muncul:
   - **Claim Tiket** - Untuk mengambil tiket
   - **Cek Status** - Lihat status antrian
   - **Bantuan** - Panduan lengkap
3. **Claim Tiket**: 
   - Klik tombol "Claim Tiket"
   - Kirim nomor/nama tiket (contoh: `TICKET-123` atau `Nama Tiket`)
   - Bot akan otomatis memproses

### Dengan Command (Alternative)

```
/menu          - Tampilkan menu utama dengan buttons
/claim TICKET-123 - Claim tiket by nomor
/claim Nama Tiket - Claim tiket by nama
/status        - Cek status antrian
/help          - Bantuan lengkap
```

## Struktur Proyek

```
chatbot/
├── index.js              # Entry point bot WhatsApp
├── src/
│   ├── bot/
│   │   └── whatsapp.js   # Handler WhatsApp
│   ├── automation/
│   │   └── koprol.js     # Selenium automation untuk Koprol
│   ├── queue/
│   │   └── ticketQueue.js # Queue management
│   └── utils/
│       ├── logger.js      # Logging utility
│       └── config.js      # Configuration
├── package.json
├── .env
└── README.md
```

## Troubleshooting

### Bot tidak bisa login WhatsApp

- Pastikan WhatsApp Web bisa diakses di browser
- Hapus folder `.wwebjs_auth` dan scan ulang QR code

### Selenium error

- Pastikan ChromeDriver terinstall dan sesuai versi Chrome
- Coba set `HEADLESS_MODE=false` di `.env` untuk debug

### Tiket tidak bisa di-claim

- Cek kredensial Koprol di `.env`
- Pastikan user memiliki akses ke tiket tersebut

## Catatan

- Bot ini menggunakan WhatsApp Web, jadi HP harus tetap online
- Untuk production, pertimbangkan menggunakan VPS/server yang selalu online
- Bot akan otomatis reconnect jika koneksi terputus

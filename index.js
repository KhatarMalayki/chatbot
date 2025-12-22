const WhatsAppBot = require('./src/bot/whatsapp');
const logger = require('./src/utils/logger');
const fs = require('fs');
const path = require('path');

const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

const bot = new WhatsAppBot();

process.on('SIGINT', async () => {
    logger.info('Received SIGINT. Shutting down gracefully...');
    await bot.stop();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM. Shutting down gracefully...');
    await bot.stop();
    process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
    if (reason && reason.message && reason.message.includes('Protocol error')) {
        logger.warn('Non-critical protocol error (ignored):', reason.message);
        return;
    }
    logger.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
    process.exit(1);
});

(async () => {
    try {
        logger.info('=================================');
        logger.info('WhatsApp Bot - Koprol Dispatcher');
        logger.info('=================================');
        
        await bot.start();
    } catch (error) {
        logger.error('Failed to start bot:', error);
        process.exit(1);
    }
})();

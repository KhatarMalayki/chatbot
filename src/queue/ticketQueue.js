const logger = require('../utils/logger');

class TicketQueue {
    constructor() {
        this.queue = [];
        this.processing = false;
        this.currentTask = null;
    }

    add(task) {
        this.queue.push(task);
        logger.info(`Task added to queue. Queue length: ${this.queue.length}`);
        
        if (!this.processing) {
            this.processNext();
        }
    }

    async processNext() {
        if (this.queue.length === 0) {
            this.processing = false;
            this.currentTask = null;
            logger.info('Queue is empty. Waiting for new tasks...');
            return;
        }

        this.processing = true;
        this.currentTask = this.queue.shift();
        
        logger.info(`Processing task: ${this.currentTask.ticketId} for user ${this.currentTask.userId}`);

        try {
            await this.currentTask.execute();
            logger.info(`Task completed: ${this.currentTask.ticketId}`);
        } catch (error) {
            logger.error(`Task failed: ${this.currentTask.ticketId}`, error);
            if (this.currentTask.onError) {
                this.currentTask.onError(error);
            }
        }

        setTimeout(() => this.processNext(), 1000);
    }

    getStatus() {
        return {
            queueLength: this.queue.length,
            processing: this.processing,
            currentTask: this.currentTask ? this.currentTask.ticketId : null,
        };
    }
}

module.exports = new TicketQueue();

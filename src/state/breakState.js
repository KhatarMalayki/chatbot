class BreakState {
    constructor() {
        this.sessions = new Map();
        this.outstandingCache = new Map();
    }

    start(userId, session = {}) {
        const payload = {
            stage: 'awaiting_ticket',
            tasks: [],
            chatId: null,
            ...session,
            updatedAt: Date.now()
        };
        this.sessions.set(userId, payload);
        return payload;
    }

    get(userId) {
        return this.sessions.get(userId) || null;
    }

    update(userId, patch = {}) {
        const session = this.sessions.get(userId);
        if (!session) {
            return null;
        }
        Object.assign(session, patch, { updatedAt: Date.now() });
        return session;
    }

    clear(userId) {
        this.sessions.delete(userId);
    }

    setOutstanding(key, data = {}) {
        if (!key) {
            return null;
        }
        const payload = {
            tasks: [],
            picName: '',
            fetchedAt: Date.now(),
            ...data
        };
        this.outstandingCache.set(key, payload);
        return payload;
    }

    getOutstanding(key) {
        if (!key) {
            return null;
        }
        return this.outstandingCache.get(key) || null;
    }

    clearOutstanding(key) {
        if (!key) {
            return;
        }
        this.outstandingCache.delete(key);
    }

    removeOutstandingTicket(key, ticketId) {
        if (!key || !ticketId) {
            return;
        }
        const cache = this.outstandingCache.get(key);
        if (!cache || !Array.isArray(cache.tasks)) {
            return;
        }
        const upperTicket = ticketId.toUpperCase();
        cache.tasks = cache.tasks.filter(
            (task) => (task.ticket || '').toUpperCase() !== upperTicket
        );
        cache.updatedAt = Date.now();
    }
}

module.exports = new BreakState();

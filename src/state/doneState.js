class DoneState {
    constructor() {
        this.sessions = new Map();
    }

    start(userId, session = {}) {
        const payload = {
            stage: 'awaiting_ticket',
            tasks: [],
            selectedTicket: null,
            answers: {},
            pendingQuestions: [],
            currentQuestion: null,
            chatId: null,
            picName: null,
            lastPromptTimestamp: null,
            ...session,
            updatedAt: Date.now(),
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
}

module.exports = new DoneState();

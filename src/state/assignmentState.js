const logger = require("../utils/logger");

class AssignmentState {
  constructor() {
    this.stateByTicket = new Map();
    this.ticketByUser = new Map();
  }

  ensure(ticketId) {
    if (!this.stateByTicket.has(ticketId)) {
      this.stateByTicket.set(ticketId, {
        stage: "idle",
        pendingQuestions: [],
        currentQuestion: null,
        answers: {},
        lastPromptTimestamp: null,
        lastReminderTimestamp: null,
        reminderCount: 0,
        userId: null,
        chatId: null,
      });
      logger.info(`Assignment state initialized for ${ticketId}`);
    }
    return this.stateByTicket.get(ticketId);
  }

  reset(ticketId) {
    if (this.stateByTicket.has(ticketId)) {
      this.stateByTicket.delete(ticketId);
      logger.info(`Assignment state cleared for ${ticketId}`);
    }
    for (const [userId, tId] of this.ticketByUser.entries()) {
      if (tId === ticketId) {
        this.ticketByUser.delete(userId);
      }
    }
  }

  setStage(ticketId, stage) {
    const state = this.ensure(ticketId);
    state.stage = stage;
    logger.info(`Assignment stage for ${ticketId} -> ${stage}`);
  }

  getStage(ticketId) {
    return this.ensure(ticketId).stage;
  }

  setPendingQuestions(ticketId, questions) {
    const state = this.ensure(ticketId);
    state.pendingQuestions = questions || [];
  }

  shiftQuestion(ticketId) {
    const state = this.ensure(ticketId);
    return state.pendingQuestions.shift();
  }

  setCurrentQuestion(ticketId, question) {
    const state = this.ensure(ticketId);
    state.currentQuestion = question || null;
  }

  getCurrentQuestion(ticketId) {
    return this.ensure(ticketId).currentQuestion;
  }

  recordAnswer(ticketId, key, value) {
    const state = this.ensure(ticketId);
    state.answers[key] = value;
  }

  getAnswer(ticketId, key) {
    const state = this.ensure(ticketId);
    return state.answers[key];
  }

  getAnswers(ticketId) {
    return this.ensure(ticketId).answers;
  }

  setContext(ticketId, context = {}) {
    const state = this.ensure(ticketId);
    state.context = Object.assign({}, context);
  }

  getContext(ticketId) {
    const state = this.ensure(ticketId);
    return state.context || {};
  }

  setUserContext(ticketId, userId, chatId) {
    const state = this.ensure(ticketId);
    state.userId = userId;
    state.chatId = chatId;
    if (userId) {
      this.ticketByUser.set(userId, ticketId);
    }
  }

  getUserContext(ticketId) {
    const state = this.ensure(ticketId);
    return { userId: state.userId, chatId: state.chatId };
  }

  getTicketForUser(userId) {
    return this.ticketByUser.get(userId) || null;
  }

  clearUser(userId) {
    if (this.ticketByUser.has(userId)) {
      const ticketId = this.ticketByUser.get(userId);
      this.ticketByUser.delete(userId);
      if (this.stateByTicket.has(ticketId)) {
        const state = this.stateByTicket.get(ticketId);
        state.userId = null;
        state.chatId = null;
      }
    }
  }

  setLastPrompt(ticketId, ts = Date.now()) {
    const state = this.ensure(ticketId);
    state.lastPromptTimestamp = ts;
  }

  getLastPrompt(ticketId) {
    const state = this.ensure(ticketId);
    return state.lastPromptTimestamp;
  }

  setLastReminder(ticketId, ts = Date.now()) {
    const state = this.ensure(ticketId);
    state.lastReminderTimestamp = ts;
  }

  getLastReminder(ticketId) {
    const state = this.ensure(ticketId);
    return state.lastReminderTimestamp;
  }

  incrementReminderCount(ticketId) {
    const state = this.ensure(ticketId);
    state.reminderCount = (state.reminderCount || 0) + 1;
  }

  getReminderCount(ticketId) {
    const state = this.ensure(ticketId);
    return state.reminderCount || 0;
  }

  getAllOpenTickets() {
    const result = [];
    for (const [ticketId, state] of this.stateByTicket.entries()) {
      result.push({ ticketId, state });
    }
    return result;
  }
}

module.exports = new AssignmentState();

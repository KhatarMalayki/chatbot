const logger = require('../utils/logger');

class AiAgent {
  constructor(cfg) {
    this.cfg = cfg || {};
  }

  // Decide user intent from free-form text
  async decide(text) {
    const t = (text || '').trim();
    const lower = t.toLowerCase();

    // 1) RF ticket pattern anywhere in text
    const rfPattern = /rf\/[a-z]{2}\/\d{2}\/\d{2}\/\d{5}/i;
    const m = t.match(rfPattern);
    if (m) {
      const ticketId = m[0].toUpperCase();
      return { intent: 'rfa', ticketId, reason: 'Detected RF ticket pattern', confidence: 0.95, used: 'rules' };
    }

    // 2) Status
    if (/(status|queue|antrian)/i.test(lower)) {
      return { intent: 'status', reason: 'Status keywords', confidence: 0.8, used: 'rules' };
    }

    // 3) End Break
    if (/(end\s*break|resume|lanjut(?:kan)?\s*break|selesai\s*break)/i.test(lower)) {
      return { intent: 'end_break', reason: 'End Break keywords', confidence: 0.85, used: 'rules' };
    }

    // 4) Break
    if (/(break|pause|istirahat)/i.test(lower)) {
      return { intent: 'break', reason: 'Break keywords', confidence: 0.8, used: 'rules' };
    }

    // 5) Menu / start
    if (/(menu|start|mulai)/i.test(lower)) {
      return { intent: 'menu', reason: 'Menu keywords', confidence: 0.8, used: 'rules' };
    }

    // 6) Help
    if (/(help|bantuan|cara|tolong|gimana|bagaimana)/i.test(lower)) {
      return { intent: 'help', reason: 'Help keywords', confidence: 0.7, used: 'rules' };
    }

    // 7) RFA/Claim without ticket
    if (/(rfa|claim|approve)/i.test(lower)) {
      return { intent: 'prompt_ticket', reason: 'RFA keyword without ticket', confidence: 0.6, used: 'rules' };
    }

    return { intent: 'unknown', reason: 'No rule matched', confidence: 0.2, used: 'rules' };
  }
}

module.exports = AiAgent;

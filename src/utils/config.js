require("dotenv").config();

module.exports = {
  koprol: {
    url: process.env.KOPROL_URL || "https://koprol.tunasgroup.com",
    username: process.env.KOPROL_USERNAME,
    password: process.env.KOPROL_PASSWORD,
  },
  admin: {
    phone: process.env.ADMIN_PHONE || "",
    picName: process.env.ADMIN_PIC_NAME || "",
  },
  selenium: {
    headless: process.env.HEADLESS_MODE === "true",
  },
  agent: {
    enabled: process.env.AGENT_ENABLED === "true",
    model: process.env.AGENT_MODEL || "rules",
    openaiApiKey: process.env.OPENAI_API_KEY || "",
  },
  notification: {
    khatarPhone: process.env.KHATAR_PHONE || "62895364520814",
  },
};

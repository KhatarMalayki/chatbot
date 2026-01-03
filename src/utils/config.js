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
  // Nomor WhatsApp per PIC untuk notifikasi otomatis
  picPhones: {
    ANGGRIONO: process.env.PIC_ANGGRIONO_PHONE || "",
    "DEO HERNOWO": process.env.PIC_DEO_HERNOWO_PHONE || "",
    "ERICK INDRA TARA": process.env.PIC_ERICK_INDRA_TARA_PHONE || "",
    "MAULIGA PENYEJUKNATE": process.env.PIC_MAULIGA_PENYEJUKNATE_PHONE || "",
    "MOHAMAD KHATAR MALAYKI": process.env.PIC_MOHAMAD_KHATAR_MALAYKI_PHONE || "",
    "MUHAMAD RUBYANSYAH PUTRA": process.env.PIC_MUHAMAD_RUBYANSYAH_PUTRA_PHONE || "",
    "MUHAMMAD RISALDI": process.env.PIC_MUHAMMAD_RISALDI_PHONE || "",
  },
};

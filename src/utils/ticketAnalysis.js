const normalize = (text = "") => text.toLowerCase();

const networkKeywords = ["jaringan", "network", "wifi", "vpn", "internet", "lan", "wan", "hotspot"];
const emailKeywords = ["email", "mail", "outlook", "imap", "smtp"];
const hardwareKeywords = ["printer", "laptop", "pc", "komputer", "mouse", "keyboard", "monitor"];
const accessKeywords = ["password", "akses", "login", "sandi", "credential"];

function cleanupDescription(raw = "") {
  const text = (raw || "").replace(/\r/g, "\n");
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const dropPrefixes = [
    "dear",
    "hi",
    "halo",
    "yth",
    "yth.",
    "kepada",
    "selamat",
  ];
  const cleaned = lines.filter((l) => {
    const lower = l.toLowerCase();
    if (dropPrefixes.some((p) => lower.startsWith(p))) return false;
    if (lower === "trims" || lower === "thanks" || lower === "thank you")
      return false;
    return true;
  });

  return cleaned.join(" ").replace(/\s+/g, " ").trim();
}

function extractProblemSnippet(description = "") {
  const clean = cleanupDescription(description);
  if (!clean) return "";

  // Split into sentences-ish chunks
  const parts = clean
    .split(/(?<=[.!?])\s+|\s+-\s+|\s{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const problemKeywords = [
    "tidak bisa",
    "ga bisa",
    "gak bisa",
    "nggak bisa",
    "tidak dapat",
    "tidak masuk",
    "lupa password",
    "reset password",
    "error",
    "gagal",
    "lemot",
    "lambat",
    "hang",
    "freeze",
    "tidak connect",
    "tidak terkoneksi",
    "disconnect",
    "tidak dapat print",
    "tidak bisa print",
  ];

  for (const p of parts) {
    const lower = p.toLowerCase();
    if (problemKeywords.some((kw) => lower.includes(kw))) {
      return p;
    }
  }

  // Fallback: first non-empty chunk
  return parts[0] || clean;
}

function guessTitle(description = "") {
  const snippet = extractProblemSnippet(description);
  if (!snippet) return "tiket";

  // Enforce a short title
  const compact = snippet.replace(/\s+/g, " ").trim();
  if (compact.length <= 45) return compact;
  return `${compact.slice(0, 42).trim()}...`;
}

function guessHelpdeskNote(description = "") {
  const snippetRaw = extractProblemSnippet(description);
  const text = normalize(snippetRaw);
  if (!text) return "analisa tiket";

  const snippet =
    snippetRaw.length > 140
      ? `${snippetRaw.slice(0, 137).trim()}...`
      : snippetRaw;

  if (text.includes("lemot") || text.includes("lambat")) {
    return `analisa jaringan lemot: ${snippet}`;
  }
  if (text.includes("error")) {
    return `analisa error: ${snippet}`;
  }
  if (text.includes("tidak bisa") || text.includes("ga bisa") || text.includes("gak bisa")) {
    return `analisa masalah: ${snippet}`;
  }
  if (accessKeywords.some((kw) => text.includes(kw))) {
    return `analisa akses: ${snippet}`;
  }
  if (hardwareKeywords.some((kw) => text.includes(kw))) {
    return `analisa perangkat: ${snippet}`;
  }
  if (networkKeywords.some((kw) => text.includes(kw))) {
    return `analisa jaringan: ${snippet}`;
  }
  if (emailKeywords.some((kw) => text.includes(kw))) {
    return `analisa email: ${snippet}`;
  }

  return `analisa: ${snippet}`;
}

function guessBobot(description = "") {
  const text = normalize(description);
  if (/(install|password|pin|reset)/i.test(text)) {
    return "Mudah";
  }
  if (/(error|tidak bisa|gagal|unknown|lemot|lambat|hang|freeze)/i.test(text)) {
    return "Sulit";
  }
  return "Sedang";
}

module.exports = {
  guessTitle,
  guessHelpdeskNote,
  guessBobot,
};

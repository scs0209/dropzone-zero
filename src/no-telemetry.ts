// Mastra reports usage to PostHog by default (hashed hostname, OS, IP-based
// location). Dropzone Zero never phones home, so this module turns that off. It
// must be imported before @mastra/core, which reads the variable at use time.
process.env.MASTRA_TELEMETRY_DISABLED = "1";

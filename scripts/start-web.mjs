// Content includes bounded embedded media and a separate recoverable authoring draft.
process.env.BODY_SIZE_LIMIT ??= String(20 * 1024 * 1024);
await import('../build/web/index.js');

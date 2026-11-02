import { defineConfig } from 'drizzle-kit';

export default defineConfig({
	schema: './src/lib/storage/schema.ts',
	out: './src/lib/storage/migrations',
	dialect: 'sqlite'
});

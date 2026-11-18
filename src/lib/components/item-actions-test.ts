import { page } from 'vitest/browser';

export async function chooseItemAction(name: string, action: 'rename' | 'delete') {
	await page.getByRole('button', { name: `${name} 작업`, exact: true }).click();
	await page
		.getByRole('button', {
			name: `${name} ${action === 'rename' ? '이름 변경' : '삭제'}`,
			exact: true
		})
		.click();
}

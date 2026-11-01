// Temporary presentation data, not the game definition or save format.
export interface PreviewGame {
	id: string;
	title: string;
	genre: string;
	description: string;
	cover: 'forest' | 'archive' | 'orbit' | 'blank';
	lastPlayed: string | null;
	saves: number;
}

export const previewGames: readonly PreviewGame[] = [
	{
		id: 'forest',
		title: '안개 너머의 숲',
		genre: '판타지 · 탐험',
		description: '지도에 없는 숲, 잊힌 길의 끝에서 당신의 이야기가 시작됩니다.',
		cover: 'forest',
		lastPlayed: '2026-11-02',
		saves: 2
	},
	{
		id: 'archive',
		title: '자정의 도서관',
		genre: '미스터리 · 어드벤처',
		description: '자정에만 열리는 도서관. 아직 쓰이지 않은 책 한 권이 당신을 기다립니다.',
		cover: 'archive',
		lastPlayed: '2026-11-01',
		saves: 1
	},
	{
		id: 'orbit',
		title: '마지막 궤도',
		genre: 'SF · 생존',
		description: '고요한 우주에서 도착한 하나의 신호. 다음 목적지는 당신의 선택에 달려 있습니다.',
		cover: 'orbit',
		lastPlayed: '2026-10-30',
		saves: 1
	},
	{
		id: 'blank',
		title: '이름 없는 세계',
		genre: '샌드박스',
		description: '아직 아무것도 정해지지 않은 세계. 첫 번째 이야기를 상상해보세요.',
		cover: 'blank',
		lastPlayed: null,
		saves: 0
	}
];

export function formatLastPlayed(date: string | null): string {
	if (!date) return '아직 플레이하지 않음';
	const [, month, day] = date.split('-');
	return `${Number(month)}월 ${Number(day)}일 플레이`;
}

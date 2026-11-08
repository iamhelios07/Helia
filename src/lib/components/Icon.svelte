<script lang="ts">
	import Activity from '@lucide/svelte/icons/activity';
	import ArrowDownUp from '@lucide/svelte/icons/arrow-down-up';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import BookOpen from '@lucide/svelte/icons/book-open';
	import Check from '@lucide/svelte/icons/check';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Download from '@lucide/svelte/icons/download';
	import Folder from '@lucide/svelte/icons/folder';
	import Gamepad2 from '@lucide/svelte/icons/gamepad-2';
	import Image from '@lucide/svelte/icons/image';
	import Info from '@lucide/svelte/icons/info';
	import LayoutGrid from '@lucide/svelte/icons/layout-grid';
	import List from '@lucide/svelte/icons/list';
	import MessageSquare from '@lucide/svelte/icons/message-square';
	import Minus from '@lucide/svelte/icons/minus';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import Search from '@lucide/svelte/icons/search';
	import SendHorizontal from '@lucide/svelte/icons/send-horizontal';
	import Settings from '@lucide/svelte/icons/settings';
	import SquarePen from '@lucide/svelte/icons/square-pen';
	import Sun from '@lucide/svelte/icons/sun';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import UserRound from '@lucide/svelte/icons/user-round';
	import Wrench from '@lucide/svelte/icons/wrench';
	import X from '@lucide/svelte/icons/x';
	const icons = {
		sun: Sun,
		grid: LayoutGrid,
		plus: Plus,
		search: Search,
		list: List,
		sort: ArrowDownUp,
		chevron: ChevronDown,
		close: X,
		folder: Folder,
		import: Download,
		edit: SquarePen,
		chat: MessageSquare,
		tool: Wrench,
		settings: Settings,
		info: Info,
		game: Gamepad2,
		image: Image,
		book: BookOpen,
		activity: Activity,
		'arrow-left': ArrowLeft,
		'arrow-right': ArrowRight,
		pencil: Pencil,
		trash: Trash2,
		check: Check,
		send: SendHorizontal,
		user: UserRound,
		minus: Minus
	};
	let { name, size = 20 }: { name: keyof typeof icons; size?: number } = $props();
	let Glyph = $derived(icons[name]);
</script>

<Glyph {size} strokeWidth={1.5} aria-hidden="true" />

# Helia

SvelteKit 3, Svelte 5, TypeScript를 사용하는 웹·데스크톱 공통 코드베이스입니다.
웹은 Node.js 서버로, 데스크톱은 Tauri 2 앱으로 배포합니다.

## 준비

- Node.js 22.12 이상인 22 LTS 또는 24 이상
- pnpm 10 (`packageManager`에 버전 고정)
- 데스크톱 개발: Rust 1.90 이상과 [운영체제별 Tauri 준비 사항](https://v2.tauri.app/start/prerequisites/)
- Windows: Visual Studio C++ Build Tools와 WebView2

```sh
pnpm install
```

Windows PowerShell에서 `pnpm.ps1` 실행이 차단되면 `pnpm` 대신 `pnpm.cmd`를 사용합니다.

## 개발과 배포

| 명령                               | 동작                                             |
| ---------------------------------- | ------------------------------------------------ |
| `pnpm dev` 또는 `pnpm dev:web`     | 웹 개발 서버                                     |
| `pnpm desktop:dev`                 | Tauri 창과 데스크톱 개발 서버 실행               |
| `pnpm dev:desktop`                 | 데스크톱용 프런트엔드만 실행, `127.0.0.1:1420`   |
| `pnpm build` 또는 `pnpm build:web` | Node.js 서버를 `build/web`에 생성                |
| `pnpm start`                       | 빌드된 Node.js 서버 실행, 기본 포트 3000         |
| `pnpm build:desktop`               | Tauri용 정적 프런트엔드를 `build/desktop`에 생성 |
| `pnpm desktop:build`               | 프런트엔드 빌드 후 현재 OS용 앱과 설치 파일 생성 |
| `pnpm check`                       | TypeScript·Svelte 검사                           |
| `pnpm lint`                        | Prettier·ESLint 검사                             |
| `pnpm test`                        | Vitest 단위·브라우저 컴포넌트 테스트             |

웹의 `pnpm preview`는 로컬 빌드 확인용입니다. 서버 배포에는 `pnpm start`를 사용합니다.
서버에 `build/web`, `package.json`, `pnpm-lock.yaml`과 운영 의존성을 배포합니다.
실행 시 `HOST`, `PORT` 환경 변수로 바인딩 주소와 포트를 설정할 수 있습니다.
프록시 뒤의 공개 origin 설정은 [Node 어댑터 문서](https://svelte.dev/docs/kit/adapter-node)를 참고하세요.

데스크톱 설치 파일은 `src-tauri/target/release/bundle`에 생성됩니다.
앱 식별자는 `src-tauri/tauri.conf.json`의 `com.helia.desktop`이며,
배포 전 소유한 식별자로 변경하세요. 제품 버전은 `package.json`에서 읽습니다.
아이콘은 Tauri 기본 아이콘이므로 배포 전 교체하세요.

## 코드 공유 방식

```text
src/
  routes/             # 웹과 데스크톱에서 공유하는 화면·라우팅
  lib/
    platform/index.ts # 빌드 대상과 Tauri 런타임 확인
    server/           # Node.js 전용 코드가 필요할 때 추가
src-tauri/            # Rust 진입점, 권한, 아이콘, 패키징 설정
vite.config.ts        # 모드에 따른 어댑터 선택
```

기본 모드는 `adapter-node`와 SSR을 사용합니다. `--mode desktop`은
`adapter-static`과 SPA를 사용합니다. `src/routes/+layout.ts`에서 데스크톱만
SSR을 끄므로 웹에서는 서버 렌더링을 유지합니다. 두 결과물은 별도 폴더에 저장됩니다.
Vite·SvelteKit 중간 산출물은 공유하므로 개발 서버와 빌드를 동시에 실행하지 마세요.

`#lib/platform/index.js`의 `isDesktopBuild`는 빌드 대상을 나타냅니다.
네이티브 API를 호출하기 전에는 같은 모듈의 `isTauri()`로 실제 Tauri 런타임인지
확인하세요. 브라우저에서 데스크톱 개발 URL을 열었을 때는 네이티브 기능을 사용할 수 없습니다.

Tauri 앱에는 Node.js 서버가 포함되지 않습니다. 데스크톱의 서버 기능은 별도 배포한
Node.js API에 연결하는 방식을 기준으로 합니다. API 주소, 인증, CORS는 기능 구현 시
설정해야 합니다. 상대 경로 `/api/...`는 Tauri에 내장된 프런트엔드를 가리키므로
원격 서버를 호출할 때는 서버 URL을 명시해야 합니다.

`+page.server.ts`, `+layout.server.ts`, form actions, 런타임 `+server.ts` API는
Node.js 서버 기능입니다. 데스크톱의 정적 결과물에는 실행할 서버가 없으므로
공통 화면에서 이 기능에 직접 의존하지 마세요. 업무 규칙·타입은 `src/lib`에,
서버 비밀값·DB 접근은 `src/lib/server`에 두고, UI는 HTTP API 또는 Tauri 기능을
호출하도록 구성합니다. 로컬 독립 실행이 필요하면 Rust 기능이나 Node.js sidecar를
추가할 수 있습니다.

## 테스트 준비

컴포넌트 테스트는 Playwright Chromium을 사용합니다. 최초 한 번 설치합니다.

```sh
pnpm exec playwright install chromium
pnpm test
```

브라우저가 필요 없는 단위 테스트만 실행하려면 `pnpm test --project server`를 사용합니다.

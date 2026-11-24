# 설치 호스트 공유 고정 데이터 (B2 / B3)

Node와 Rust(`include_str!`)가 같은 JSON을 읽는다. 각 사례는 독립된 빈 저장소에서
`setup` 요청을 순서대로 실행한 후 `request`를 실행한다. `scenario.json`만 단일 객체이며,
`setup` 다음 `steps`를 **같은 저장소**에서 순서대로 실행한다.

- `content-cases.json`: B1의 같은 이름 파일을 그대로 복사했다. 모든 수용·거부 경계와
  `errorCode`를 유지한다. B1이 갱신되면 두 파일을 함께 갱신한다.
- `release-cases.json`: B1의 시각 고정 데이터 복사본. 호스트는 패키지 원본
  `release.createdAt`을 별도로 검증해야 한다. B1 콘텐츠 검증만으로 대체하지 않는다.
- `conflict-cases.json`: 같은 해시 별도 설치, 충돌 무시, 버전 변경 후 무시, K 변경,
  K는 같고 들어오는 콘텐츠만 변경, 원본·최종 버전·들어오는 해시 결합 오류,
  K 공집합에서 오래된 확인 값, 잘못된 확인 값·버전, 기존 ID, Trash 제외를 포함한다.
- `scenario.json`: V 충돌 → V′ 변경 → V′ 충돌 → 무시 → V′ 설치. 원본 V 행을
  생성하지 않고 출처는 V를 유지해야 한다.
- `error-codes.json`: TS `GamePackageErrorCode`와 B3가 공유하는 오류 코드 목록이다.
  `format`, `version`, `integrity`, `limit`, `content`, `nonCanonical`, `installOnlyKey`,
  `newerHeliaRequired`, `staleAcknowledgement`를 포함한다. K가 비어 있어도 확인 값의
  원본·최종 버전·들어오는 해시 결합이 다르면 `staleAcknowledgement`로 거부한다.
  모든 오류는 메시지 문자열 비교 없이 이 코드로 판정하며, 웹 400 응답의 `errorCode`도
  클라이언트에서 같은 `GamePackageError`로 복원한다.

`expect.accepted`는 실제 설치 완료를 뜻한다. `conflict`가 있으면 예외 없이 그 결과를
반환하고 쓰기는 0개다. `errorCode`가 있으면 거부하며 쓰기는 0개다.
`normalizedContent`·`contentHash`는 저장된 릴리스를 검사한다.
`release`는 저장된 릴리스 요약과 부분 비교하고 `installedFrom`은 정확히 비교한다.
두 기대값의 문자열 `$now`는 해당 설치 게임 행의 호스트 `createdAt`으로 바꾼다.
릴리스 ID는 각 호스트가 생성하므로 고정하지 않는다.

큰 원본 복잡도·문자 예산, 확인 해시 10,000개 경계와 +1, 단계별 SQL 실패 주입,
출처 강제 보존 및 해시 무영향은 JSON 크기를 늘리지 않고 각 호스트 테스트로 검증한다.
TS는 `server/game-install.spec.ts`와 `server/package-release.spec.ts`에 있다.

웹 서버의 설치 진입점은 `Storage.requestAsync` / `storageSyncAsync`다. 검증할 요청을
복제하여 B1 `verifyReleaseContent`로 검증한 뒤, DB 상태 의존 판정과 모든 쓰기를
하나의 IMMEDIATE 트랜잭션에서 실행한다. 동기 `Storage.request`는 설치를 거부한다.
`installPreview`는 콘텐츠 없이 소문자 원본 UUID·SemVer만 검증한다.
미리보기는 deferred 읽기 트랜잭션에서 설치본들의 릴리스 이력을 SQL 한 번으로 조회한다.
`install`과 `installPreview`는 직접 전송하며 `sync` 봉투 안에서는 거부한다.
미리보기의 `existingHashes`는 각 설치본의 요청 버전 해시 집합이다. 충돌 확인 값은
미리보기가 아닌 설치 호스트의 `conflict` 응답에서만 가져온다.

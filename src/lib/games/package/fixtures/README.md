# 게임 패키지 v1 고정 데이터

`content-cases.json`과 `release-cases.json`은 Node와 Rust 설치 테스트가 함께 읽는
`{ name, request, expect }` 사례 배열이다. 각 사례는 빈 저장소에서 독립적으로 실행한다.
`request`는 별도 설치 요청 형태이며 `expect.accepted`는 수용 여부,
수용 사례의 `normalizedContent`와 `contentHash`는 정규화 결과와 기존 릴리스 다이제스트다.
거부 사례의 `errorCode`는 패키지 검증 계층의 코드다. 호스트의 전송 오류 포장은 별도로 검사한다.

- `content-cases.json`: 콘텐츠·어댑터 사례 40개. 제작자 키, 정상 유니코드,
  IEEE-754 숫자, 레거시 scripts/UI, code/presentation, 공유 에셋, 빈 리소스,
  제목 길이 경계, 모든 설치 전용 키(`editLock` 포함), 미지·컴파일 필드,
  `scripts: null` 거부, 공백 정규화, 잘못된 해시·UUID를 포함한다.
  릴리스 해시 형식 오류(길이·대문자)는 `verifyReleaseContent`에서 `content` 코드로
  보고된다. 같은 값이 매니페스트 경로에서는 `format`이므로 두 계층의 기대값을 섞지 않는다.
- `release-cases.json`: 시각 문법의 수용·거부 사례 10개. **호스트는 콘텐츠 검증과
  별도로 요청 릴리스의 `createdAt`을 `packageTimestamp`로 검사해야 한다.**
  `verifyReleaseContent`의 `ids.now`는 호스트가 생성한 현재 시각이며 원본 릴리스
  시각을 대신 검증하지 않는다. 시각 형식 오류의 `errorCode`는 매니페스트 경로의
  `format`이다.
- `minimal-release.json`: 바이트 고정 테스트의 작은 정규형 릴리스.
- `surrogate-cases.json`: 키·문자열 값의 고립 UTF-16 surrogate는 `content`로 거부한다.
  Rust도 읽을 수 있도록 원본 설치 요청을 `rawJson` 문자열로 감쌌다.
- `minimal-package.json`: 위 릴리스의 독립 작성기로 만든 패키지 전체 base64와 SHA-256.
  실행 시 재생성하지 않으며 TS 작성기가 바이트 단위로 일치해야 한다.

코디네이터 확인에 따라 제목 양끝의 U+0085는 ECMAScript trim이 보존하므로 수용한다.
U+00A0처럼 trim이 제거하는 공백은 입력 정규형 위반으로 거부한다.
미지 필드·설치 전용 키 등 일부 거부 사례는 정규화한 콘텐츠의 올바른 해시를 신고하므로,
해시 검사만으로 정규형 입력 검사를 대신할 수 없는 경우도 검증한다.
JSON의 `-0`은 `0`으로 저장되므로 부호 있는 0의 동등성은 테스트에서 별도로 확인한다.

메모리를 많이 쓰는 한도 경계는 각 spec에서 재현한다. 원본 노드 100,000개·깊이 64·
문자열 16 Mi UTF-16 단위와 각각의 +1, JSON 실제 UTF-8 크기, ZIP 65,534항목,
32 MiB 파일, 에셋 8 MiB/합계 24 MiB, 공유 참조 확장 크기를 포함한다.
충돌·출처·트랜잭션 고정 데이터는 B2가 별도로 소유한다.

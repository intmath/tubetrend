# 1단계: 기존 데이터베이스 삭제 및 생성 (로컬 전용)
로컬에서 테스트 중이므로, 에뮬레이터에 쌓인 데이터를 지우고 새로 만듭니다.

1. 로컬 데이터 폴더 삭제 프로젝트 폴더 안에 있는 .wrangler 폴더를 삭제하세요. (이 폴더를 지우면 로컬 DB 파일이 물리적으로 삭제됩니다.)

2. 스키마 파일(schema.sql) 작성 프로젝트 루트 폴더에 파일을 만들고 아래 내용을 복사해 넣으세요.

SQL

DROP TABLE IF EXISTS ChannelStats;
DROP TABLE IF EXISTS Channels;

CREATE TABLE Channels (
    id TEXT PRIMARY KEY,
    title TEXT,
    country TEXT,
    category TEXT,
    thumbnail TEXT
);

CREATE TABLE ChannelStats (
    channel_id TEXT,
    subs INTEGER,
    views INTEGER,
    rank_date DATE,
    PRIMARY KEY(channel_id, rank_date)
);


3. 로컬 DB에 테이블 생성 터미널에서 아래 명령어를 입력합니다.

Bash

npx wrangler d1 execute tube-db --local --file=./schema.sql


정상 실행 시 출력 메시지:

✔ Success! 2 commands executed. 라는 메시지가 나와야 합니다.

2. 테이블 생성 확인 (검증)
테이블이 정말로 만들어졌는지 확인하기 위해 아래 명령어를 입력해 보세요.

Bash

# 2. 로컬 DB의 테이블 목록 조회
npx wrangler d1 execute tube-db --local --command="SELECT name FROM sqlite_master WHERE type='table';"
결과 확인: 목록에 Channels와 ChannelStats가 보여야 합니다. 만약 아무것도 나오지 않는다면 1번 단계에서 schema.sql 파일 경로가 틀렸거나 파일 내용이 비어 있을 수 있습니다.



2단계: 환경 설정 파일 확인
1. wrangler.toml (DB 바인딩) DB 이름(tube-db)과 코드 내의 이름(DB)이 일치해야 합니다.

Ini, TOML

name = "tube-trend-pro"
main = "src/index.js"
compatibility_date = "2026-01-12"

[[d1_databases]]
binding = "DB"
database_name = "tube-db"
database_id = "local-testing"
2. .dev.vars (API 키) 로컬 테스트 시 비밀번호 역할을 합니다. 반드시 루트 폴더에 만들어주세요.

Plaintext

YOUTUBE_API_KEYS=본인의_유튜브_API_키_입력
3단계: 소스코드 저장 (src/index.js)
제공해주신 코드를 src/index.js에 그대로 저장하세요.

주의: 코드 내에 CURRENT_DATE를 사용하므로, 수집 즉시 데이터가 보이기 위해서는 로컬 PC의 날짜와 서버 쿼리가 일치해야 합니다.

4단계: 로컬 테스트 및 데이터 수집 (핵심)
이제 서버를 실행하고 데이터를 채워넣는 단계입니다.

1. 로컬 서버 실행

Bash

npx wrangler dev --local
터미널에 뜨는 주소(예: http://localhost:8787)를 브라우저로 엽니다.

2. 국가별 데이터 수집 (영국, 브라질 포함) 처음 접속하면 데이터가 아무것도 없습니다. 아래 순서로 진행하세요.

영국 수집: 메뉴에서 United Kingdom(GB) 선택 → Sync Data 클릭 → "GB data synchronization complete!" 알림 확인.

브라질 수집: 메뉴에서 Brazil(BR) 선택 → Sync Data 클릭.

한국 수집: 메뉴에서 South Korea(KR) 선택 → Sync Data 클릭.



꿀팁: DB에 데이터가 들어갔는지 직접 확인하기
서버를 띄워둔 상태에서 새 터미널을 열고 아래 명령어를 입력해 보세요. 데이터가 실제로 찍힌다면 UI(화면) 코드의 문제이고, 안 찍힌다면 수집 로직의 문제입니다.

Bash

# 로컬 DB에 채널이 몇 개 있는지 확인
npx wrangler d1 execute tube-db --local --command="SELECT count(*) FROM Channels;"

# 저장된 통계 데이터 확인
npx wrangler d1 execute tube-db --local --command="SELECT * FROM ChannelStats LIMIT 5;"




🔍 데이터가 정말 DB에 들어갔는지 확인하는 법
코드를 수정했는데도 안 보인다면, 실제로 Sync가 성공해서 DB에 데이터가 쌓였는지 터미널에서 직접 확인해야 합니다. wrangler dev를 실행 중인 상태에서 새 터미널을 열고 아래 명령어를 입력하세요.

1. 채널 정보가 들어있나? (결과에 채널 이름들이 나와야 함)

Bash

npx wrangler d1 execute tube-db --local --command="SELECT title, country FROM Channels LIMIT 10;"
2. 통계 데이터와 날짜가 기록되었나? (rank_date가 어떻게 찍혀있는지 확인)

Bash

npx wrangler d1 execute tube-db --local --command="SELECT * FROM ChannelStats LIMIT 10;"
💡 만약 위 명령어 결과가 "비어있음"으로 나온다면?
그것은 유튜브 API 호출 자체가 실패하고 있는 것입니다. .dev.vars 파일을 다시 점검해 주세요.

파일 위치: src 폴더 안이 아니라, wrangler.toml과 같은 최상위 폴더에 있어야 합니다.

형식: YOUTUBE_API_KEYS=AIza... (공백이나 따옴표 없이 입력)

재시작: .dev.vars를 수정했다면 npx wrangler dev를 껐다가 다시 켜야 적용됩니다.




.dev.vars 파일 내용 정밀 점검
가장 흔한 실수는 키 주변에 공백이나 따옴표가 들어가는 것입니다. 파일을 열어 아래와 똑같은 형식인지 확인하세요.

위치: src 폴더 안이 아니라, wrangler.toml이 있는 최상위(루트) 폴더에 있어야 합니다.

형식: 따옴표(", ')나 쉼표 없이 키만 바로 적어야 합니다.

변수명: 코드에서 YOUTUBE_API_KEYS를 사용하므로 정확히 일치해야 합니다.

Plaintext

# 올바른 예 (공백 없음, 따옴표 없음)
YOUTUBE_API_KEYS=AIzaSy...자신의키문자열

# 틀린 예 (절대 안 됨)
YOUTUBE_API_KEYS = AIzaSy... (공백 포함)
YOUTUBE_API_KEYS="AIzaSy..." (따옴표 포함)



SQL 명령어 직접 실행 테스트

터미널에서 아래 명령어를 쳤을 때 에러가 나는지 확인하세요.

Bash

npx wrangler d1 execute tube-db --local --command="SELECT * FROM Channels LIMIT 1;"

여기서 no such table이 나오면 npx wrangler d1 execute tube-db --local --file=./schema.sql을 다시 실행해야 합니다.







GitHub에서 코드를 가져올(Fetch/Pull) 때 데이터베이스가 사라지는 문제는 보통 Cloudflare Wrangler의 로컬 데이터 저장 경로(.wrangler 폴더) 때문입니다.

로컬 D1 데이터베이스는 프로젝트 폴더 내의 숨겨진 폴더인 .wrangler/state에 파일 형태로 저장되는데, 이 폴더가 관리되지 않거나 초기화되면 데이터가 날아간 것처럼 보이게 됩니다. 이를 방지하고 데이터를 안전하게 유지하는 방법을 정리해 드립니다.

1. .gitignore 설정 확인 (가장 중요)
GitHub에서 코드를 가져올 때 로컬 DB 파일이 꼬이지 않으려면 .wrangler 폴더가 Git 추적 대상에서 제외되어야 합니다. 프로젝트 최상위의 .gitignore 파일에 아래 내용을 반드시 추가하세요.

Plaintext

# .gitignore 파일
.wrangler
.dev.vars
주의: 만약 이미 .wrangler 폴더가 GitHub에 올라가 있다면, 다른 컴퓨터에서 git pull을 할 때 내 로컬 DB 파일을 덮어버리거나 지워버릴 수 있습니다. 이 경우 아래 명령어로 Git에서 해당 폴더를 추적 중지시켜야 합니다. git rm -r --cached .wrangler

2. 로컬 DB 대신 '원격(Remote) DB' 사용하기
로컬 환경에서 개발하더라도 데이터베이스는 Cloudflare 서버에 있는 실제 D1을 바라보게 하면, 코드를 아무리 수정하거나 GitHub에서 새로 가져와도 데이터가 항상 유지됩니다.

방법: npx wrangler dev 명령어를 실행할 때 --remote 옵션을 붙여주세요.

Bash

# 로컬 코드를 실행하되, DB는 Cloudflare 서버의 실제 DB 사용
npx wrangler dev --remote
장점: 여러 컴퓨터에서 작업해도 데이터가 동기화됩니다.

주의: 인터넷 연결이 필요하며, 실데이터가 수정될 수 있습니다.

3. 데이터베이스 백업 및 복구 (Dump)
GitHub에서 코드를 대대적으로 업데이트하기 전에 현재 로컬 DB 데이터를 SQL 파일로 뽑아두면 언제든 복구할 수 있습니다.

백업하기 (로컬 -> SQL파일):

Bash

npx wrangler d1 export tube-db --local --output ./backup.sql
복구하기 (SQL파일 -> 로컬):

Bash

npx wrangler d1 execute tube-db --local --file ./backup.sql
4. 시드(Seed) 데이터 활용
매번 데이터를 새로 수집하는 것이 번거롭다면, 최소한의 기초 데이터를 seed.sql 파일로 만들어두고 GitHub에 함께 올려 관리하세요. 코드를 새로 Fetch 받은 후 테이블이 비어있다면 이 파일을 실행하여 기본 상태를 즉시 복원할 수 있습니다.

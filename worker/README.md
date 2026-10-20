# Joo-JeoB 이용 기록 서버 (Cloudflare Worker + D1)

로그인·가입한 사람의 이용 기록을 모아 관리자 페이지에서 보여 줍니다. 서버리스라 따로 켜 둘 서버가 없습니다.

- 모으는 것: 무작위 기기 ID, 프로필 이름, 가입·마지막 로그인·마지막 접속 시각, 로그인 횟수, 만든 영상 수, 기기 종류(예: iPhone · Safari)
- 모으지 않는 것: 비밀번호, 영상, 음악, 「로그인 없이 사용」한 사람의 기록
- 앱에서 기록 전송에 동의한 사람만 보냅니다. 마지막 이용 후 1년이 지난 기록은 저절로 지워집니다.

## 처음 한 번 설정

### 방법 1. Cloudflare 대시보드 (명령줄 없이)

1. **Worker 만들기**: Workers & Pages → Create → Worker → 이름 `joo-jeob-admin` → Deploy → **Edit code**.
   그리고 `index.js` 내용을 통째로 붙여 넣고 Deploy 합니다.
2. **데이터베이스 만들기**: Storage & Databases → D1 → Create → 이름 `joo-jeob`.
3. **연결하기**: 만든 Worker → Settings → Bindings → Add → D1 database → 변수 이름 `DB`, 데이터베이스 `joo-jeob`.
4. **관리자 비밀번호 정하기**: 같은 Settings → Variables and Secrets → Add → Type **Secret**, 이름 `ADMIN_PASS`, 값은 직접 정한 비밀번호(12자 이상).
5. **인증 앱 키 정하기(2단계 인증)**: Worker 주소 뒤에 `/admin` 을 붙여 열면 점검표와 「인증 앱 키 만들기」 버튼이 나옵니다.
   - 만들어진 키를 휴대폰 인증 앱(Google Authenticator 등)에 추가합니다.
   - 같은 키를 Variables and Secrets → Add → Type **Secret**, 이름 `ADMIN_TOTP` 에 넣습니다.
   - 키는 그 화면 안에서만 만들어지고 어디로도 보내지 않습니다.
6. **(권장) 앱 주소만 받기**: Variables and Secrets → Add → Type Text, 이름 `ALLOW_ORIGIN`, 값 `https://joo-jeo-b.vercel.app`.
   주소가 여러 개면 쉼표로 이어 씁니다. 비워 두면 어느 사이트에서 오든 받습니다.

### 방법 2. 명령줄 (wrangler 로그인이 된 PC)

```
cd worker
npx wrangler d1 create joo-jeob          # 나온 database_id 를 wrangler.toml 에 넣는다
npx wrangler deploy
npx wrangler secret put ADMIN_PASS       # 물어보면 관리자 비밀번호(12자 이상) 입력
npx wrangler secret put ADMIN_TOTP       # /admin 에서 만든 인증 앱 키 입력
```

표는 첫 요청 때 저절로 만들어지므로 SQL을 따로 실행할 필요는 없습니다.

## 앱과 잇기

배포하면 `https://joo-jeob-admin.<내 이름>.workers.dev` 같은 주소가 생깁니다.
앱 `index.html` 맨 위 스크립트의 `const TRACK_URL = '';` 따옴표 안에 이 주소를 넣고 배포하세요.

- 비어 있으면: 아무것도 보내지 않습니다. 동의 칸도 숨겨지고 "서버로 가지 않습니다" 안내가 그대로입니다.
- 넣으면: 로그인 화면에 동의 칸이 생기고, 개인정보 안내 문구가 사실대로 바뀝니다.

## 관리자 페이지

`https://joo-jeob-admin.<내 이름>.workers.dev/admin` 에서 관리자 비밀번호와 인증 앱의 6자리 코드로 엽니다.

주인만 들어오도록 이렇게 막습니다.
- 비밀번호와 인증 앱 코드가 둘 다 맞아야 합니다. 어느 쪽이 틀렸는지는 알려 주지 않고, 한 번 쓴 코드는 다시 못 씁니다.
- 같은 곳에서 15분에 5번, 전체에서 1시간에 30번 틀리면 잠시 잠깁니다.
- 로그인은 8시간짜리 쿠키(HttpOnly · Secure · SameSite=Strict)로 유지되고, 비밀번호는 브라우저에 남지 않습니다.
- 설정(DB · ADMIN_PASS · ADMIN_TOTP)이 하나라도 빠져 있으면 목록을 아예 내주지 않습니다.

전체·최근 7일 접속·총 로그인·만든 영상 수, 이름·기기 검색, 정렬, 한 사람 기록 삭제를 할 수 있습니다.
같은 이름이라도 기기가 다르면 다른 사람으로 셉니다. 계정이 각 기기 안에만 있기 때문입니다.

## 바꾸고 싶을 때

- 관리자 비밀번호: Settings → Variables and Secrets 에서 `ADMIN_PASS` 를 고칩니다(명령줄은 `npx wrangler secret put ADMIN_PASS`).
- 휴대폰을 바꿨을 때: `ADMIN_TOTP` 를 지우고 `/admin` 에서 새 키를 만들어 다시 넣습니다.
- 코드: `index.js` 를 고쳐 다시 붙여 넣거나 `npx wrangler deploy`.

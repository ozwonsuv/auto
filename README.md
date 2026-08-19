# RDO 오늘의 도전 웹 생성기

GitHub Pages에서 정적으로 실행되는 개인용 오늘의 도전 생성기입니다. 서버, 데이터베이스, 유료 기능, 예약 작업이 필요하지 않습니다.

## 사용 방법

1. 웹페이지에서 `오늘 생성`을 누릅니다.
2. API 날짜와 마담 나자르 날짜가 한국 시간 기준 날짜와 모두 일치할 때만 미리보기가 열립니다.
3. `제목 복사`와 `본문 전체 복사(웹 이미지 포함)`를 사용합니다.

페이지는 게시판에 직접 접속하거나 글을 등록하지 않습니다. 클립보드 복사까지만 수행합니다.

## 데이터 흐름

- 오늘의 도전: `https://pepegapi.jeanropke.net/v3/rdo/dailies`
- 마담 나자르: `https://pepegapi.jeanropke.net/v2/rdo/nazar`
- 공식 한국어 문구: `https://jeanropke.github.io/RDOMap/langs/ko.json`
- 게시용 문구: `data/challenges.json`
- 링크와 이미지 매핑: `data/rules.json`

엑셀에 없는 새 도전은 공식 한국어 문구로 자동 대체되며 생성을 막지 않습니다. 등록되지 않은 나자르 위치 코드는 잘못된 이미지를 복사하지 않도록 명시적 오류로 처리합니다.

## 문구 데이터 갱신

로컬 원본 엑셀이나 규칙을 수정한 뒤 프로젝트 상위 폴더에서 다음 명령을 실행합니다.

```powershell
pwsh -NoProfile -File .\rdo-web\tools\Export-RdoWebData.ps1
```

GitHub Pages는 공개 저장소의 `main` 브랜치 루트만 사용하며 별도 비용이 들지 않습니다.

# Лендинг + личный кабинет (Remnawave 3.3 + Platega + Resend)

Node.js 24, Express, SQLite (встроенный `node:sqlite`). Внешних сервисов, кроме панели, Platega и Resend, нет.

## Что умеет

- **Лендинг** (`/`): возможности, шаги подключения, тарифы с ценами, FAQ, контакты. Всё рендерится на сервере, поэтому банк увидит тарифы и контакты даже без JavaScript.
- **Документы:** `/terms` (пользовательское соглашение), `/privacy` (политика конфиденциальности), `/contacts` (поддержка). Ссылки на них есть в шапке, подвале и форме оплаты.
- **Кодовое слово** для проверки Platega выводится в подвале каждой страницы. После регистрации кассы очистите его в админке (**Настройки**).
- **Личный кабинет** (`/cabinet`): вход по email и одноразовому коду, статус подписки, ссылка, QR-код, число устройств, продление, история платежей.
- **Оплата:** разовые платежи через Platega (`/v2/transaction/process`), способ оплаты клиент выбирает на форме Platega. Автосписаний нет.
- **Выдача доступа:** после подтверждённой оплаты создаётся пользователь в Remnawave, а если он уже есть — срок продлевается от текущей даты окончания. Ссылка на подписку приходит на почту.
- **Пробный период:** один раз на email. Дополнительно — один раз на устройство (HWID): если устройство уже подключалось к другой пробной подписке, новая пробная подписка отключается.
- **Админка** по секретному пути: пользователи и подписки, платежи и возвраты, статистика, тарифы, приложения, настройки, сотрудники с ролями, журнал действий. Подробнее — в разделе [Админка](#админка).

## Быстрый тестовый запуск (демо, без ключей)

Нужен только Node.js 22.13+ (проверка: `node -v`).

```bash
npm install
npm run demo
```

Откройте http://localhost:3000. В демо-режиме Platega и Remnawave заменены заглушками: настоящих платежей нет, панель не нужна, `.env` не требуется.

Что попробовать:
1. **Лендинг:** главная, тарифы, `/terms`, `/privacy`, `/contacts`.
2. **Вход:** «Личный кабинет» → введите любой email → **код входа появится в консоли**, где запущен `npm run demo` (строка `Код входа: 123456`).
3. **Оплата:** выберите тариф → поставьте галочку → «Оплатить» → откроется **тестовая платёжная страница** → «Оплатить». Вас вернёт в кабинет с активной подпиской, ссылкой и QR-кодом. Кнопка «Отменить» показывает сценарий неудачной оплаты.
4. **Продление:** оплатите ещё раз — срок увеличится.
5. **Пробный период:** войдите под другим email → «Активировать пробный период».
6. **Админка:** http://localhost:3000/admin-demo/ — логин `admin` / пароль `admin` (или `support` / `support` для роли поддержки). В демо эти учётки входят без 2FA; настоящие админы всегда проходят 2FA.

Порт по умолчанию 3000. Другой можно задать через `DEMO_PORT`, например в PowerShell: `$env:DEMO_PORT=3300; npm run demo`.

Письма в демо не отправляются, их текст выводится в консоль. Остановить: `Ctrl+C`. Начать заново: удалите `data/demo.db`. Заглушка панели хранит пользователей в памяти, поэтому после перезапуска демо старые подписки «пропадут» — это нормально.

Запуск с реальными ключами локально: `cp .env.example .env`, заполните его и выполните `npm start`. Callback от Platega на `localhost` не дойдёт, но статус оплаты подтянется, когда вы вернётесь в кабинет.

## Установка на сервер

Команды ниже рассчитаны на Ubuntu/Debian и пользователя с `sudo`. Репозиторий: `https://github.com/Sm1le70/vpn-landing`. Замените `example.com` на ваш домен (A-запись домена должна указывать на IP сервера).

### 1. Docker и Git

Пропустите, если Docker уже стоит (например, рядом с панелью Remnawave):

```bash
sudo apt update && sudo apt install -y git curl
curl -fsSL https://get.docker.com | sudo sh
docker compose version    # проверка
```

### 2. Скачать проект

```bash
sudo mkdir -p /opt/vpn-landing && sudo chown $USER: /opt/vpn-landing
git clone https://github.com/Sm1le70/vpn-landing.git /opt/vpn-landing
cd /opt/vpn-landing
```

Если репозиторий **приватный**, нужен доступ только на чтение. Проще всего — deploy key:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/vpn_landing_deploy -N ""
cat ~/.ssh/vpn_landing_deploy.pub
# GitHub → репозиторий → Settings → Deploy keys → Add deploy key (без права записи)
GIT_SSH_COMMAND="ssh -i ~/.ssh/vpn_landing_deploy" \
  git clone git@github.com:Sm1le70/vpn-landing.git /opt/vpn-landing
cd /opt/vpn-landing
git config core.sshCommand "ssh -i ~/.ssh/vpn_landing_deploy"   # чтобы работал git pull
```

### 3. Настроить `.env`

```bash
cp .env.example .env
# Секреты генерируются сразу в .env:
sed -i "s|^APP_SECRET=.*|APP_SECRET=$(openssl rand -hex 32)|" .env
sed -i "s|^ADMIN_PATH=.*|ADMIN_PATH=/panel-$(openssl rand -hex 6)|" .env
nano .env
```

В `nano` заполните как минимум:
- `SITE_URL=https://example.com`;
- `REMNAWAVE_URL`, `REMNAWAVE_TOKEN`, `REMNAWAVE_SQUADS`, `REMNAWAVE_WEBHOOK_SECRET`;
- `PLATEGA_MERCHANT_ID`, `PLATEGA_SECRET`;
- `RESEND_API_KEY`, `MAIL_FROM`.

Название, контакты и дату документов можно задать здесь же или потом в админке. Путь к админке посмотрите командой `grep ADMIN_PATH .env` и сохраните его — он нужен для входа.

`.env` и папка `data/` в Git не попадают (см. `.gitignore`), поэтому ключи и база не утекут при `git push`.

### 4. Запустить

```bash
mkdir -p data && sudo chown 1000:1000 data     # контейнер работает от пользователя node (uid 1000)
docker compose up -d --build
docker compose logs vpn-landing                # ссылка для создания первого админа
```

Приложение слушает `127.0.0.1:3000` — снаружи оно недоступно, пока перед ним не встанет reverse-proxy.

### 5. HTTPS через Caddy

Platega принимает callback только на HTTPS с валидным сертификатом. Если на сервере ещё нет reverse-proxy:

```bash
sudo apt install -y caddy
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
example.com {
    reverse_proxy 127.0.0.1:3000
}
EOF
sudo systemctl reload caddy
```

Caddy сам получит сертификат Let's Encrypt (порты 80 и 443 должны быть открыты). Если на сервере уже работает Caddy или nginx панели Remnawave, добавьте в его конфиг отдельный блок для домена лендинга с тем же `reverse_proxy 127.0.0.1:3000`.

**Панель Remnawave на этом же сервере.** Сайт может обращаться к ней по внутренней сети Docker, без выхода в интернет. Для этого:
1. в `docker-compose.yml` раскомментируйте блоки `networks` (сеть панели обычно называется `remnawave-network`, проверьте командой `docker network ls`);
2. укажите в `.env` `REMNAWAVE_URL=http://remnawave:3000`;
3. выполните `docker compose up -d`.

### 6. Проверить

- `https://example.com` — лендинг, тарифы, `/terms`, `/privacy`, `/contacts`.
- `https://example.com/<ADMIN_PATH>/` — админка: создайте первого администратора по ссылке из логов (шаг 4).
- В кабинете Platega укажите callback `https://example.com/webhooks/platega`, в `.env` панели — вебхук `https://example.com/webhooks/remnawave` (подробности ниже, в разделе «Настройка»).
- Сделайте тестовую оплату минимального тарифа.

### Обновление

```bash
cd /opt/vpn-landing
git pull
docker compose up -d --build
docker compose logs -f --tail=50 vpn-landing    # убедиться, что запустилось (Ctrl+C — выйти из логов)
```

База данных лежит в `data/` вне контейнера и при обновлении сохраняется, новые колонки добавляются автоматически.

### Резервная копия

Всё состояние — это `data/app.db` (пользователи, заказы, админы, настройки) и `.env`:

```bash
cd /opt/vpn-landing
mkdir -p backups
docker compose exec vpn-landing node -e "new (require('node:sqlite').DatabaseSync)('/app/data/app.db').exec(\"VACUUM INTO '/app/data/backup.db'\")"
mv data/backup.db backups/app-$(date +%F).db && cp .env backups/env-$(date +%F)
```

Ежедневный бэкап по cron (хранятся 14 последних копий):

```bash
( crontab -l 2>/dev/null; echo "0 4 * * * cd /opt/vpn-landing && docker compose exec -T vpn-landing node -e \"new (require('node:sqlite').DatabaseSync)('/app/data/app.db').exec(\\\"VACUUM INTO '/app/data/backup.db'\\\")\" && mv data/backup.db backups/app-\$(date +\\%F).db && ls -1t backups/app-*.db | tail -n +15 | xargs -r rm" ) | crontab -
```

Восстановление: `docker compose down`, положить копию как `data/app.db`, `docker compose up -d`.

### Полезные команды

```bash
docker compose ps                                  # статус
docker compose logs -f vpn-landing                 # логи в реальном времени
docker compose restart                             # перезапуск
docker compose exec vpn-landing npm run admin:list # администраторы
```

Без Docker: `git clone …`, `cp .env.example .env`, затем `npm ci --omit=dev && npm start` (нужен Node.js ≥ 22.13; для автозапуска — systemd или pm2).

## Админка

### Первый запуск
1. Задайте в `.env` секретный путь, например `ADMIN_PATH=/panel-x7k2` (латиница, цифры, `_` и `-`, от 6 символов). По другим адресам админки не видно: там обычный 404.
2. Запустите сайт и посмотрите лог:
   ```bash
   docker compose logs vpn-landing
   ```
   Там будет одноразовая ссылка вида `https://example.com/panel-x7k2/#/setup/…` (действует 1 час, при каждом перезапуске выдаётся новая, пока админ не создан).
3. Откройте ссылку, задайте логин и пароль, отсканируйте QR-код в приложении-аутентификаторе (Google Authenticator, Aegis, 1Password…) и сохраните 10 резервных кодов.

Остальных сотрудников приглашайте из админки (**Администраторы → Пригласить**): вы получите одноразовую ссылку на 24 часа.

### Восстановление доступа из консоли
Если все админы потеряли доступ (телефон с 2FA и резервные коды):
```bash
docker compose exec vpn-landing npm run admin:list
docker compose exec vpn-landing npm run admin:reset -- --login ivan         # новая ссылка: пароль + 2FA
docker compose exec vpn-landing npm run admin:create -- --login olga --role support
```
Команды печатают одноразовую ссылку. Без Docker — те же `npm run …` в папке проекта.

### Роли
| | Поддержка | Администратор |
|---|:-:|:-:|
| Пользователи и платежи (просмотр, поиск) | ✓ | ✓ |
| Сброс устройств, перевыпуск и повторная отправка ссылки | ✓ | ✓ |
| Продление подписки | до 7 дней за раз | без ограничений, в т.ч. сокращение |
| Выдача доступа без оплаты, отключение/включение, сброс пробного периода | — | ✓ |
| Возвраты через Platega, сверка заказов | — | ✓ |
| Сводка, CSV, тарифы, приложения, настройки, сотрудники | — | ✓ |
| Журнал | только свои действия | все |

Каждое действие с клиентом требует причину и пишется в журнал (кто, когда, что было до и после). Для большинства действий есть галочка «Уведомить клиента по email».

### Возвраты
В платеже: **Возврат** → админка проверяет возможность возврата в Platega и показывает, сколько USDT спишется с баланса → вы выбираете, что сделать с подпиской (снять дни этого заказа, отключить, не трогать) → подтверждаете. Если Platega отвечает, что нужна ручная обработка, заказ получает статус «Возврат в обработке» — свяжитесь с поддержкой Platega.

### Безопасность
- Пароли хранятся как scrypt-хэши, 2FA (TOTP) обязательна, резервные коды одноразовые.
- 5 неверных попыток входа — блокировка логина и IP на 15 минут.
- Сессия админа — 12 часов, cookie только для пути админки (`SameSite=Strict`).
- Отключённый клиент не может оплатить подписку из кабинета, пока его не включат.

## Настройка

### Тарифы, приложения, контакты, пробный период
Редактируются в админке (**Тарифы**, **Приложения**, **Настройки**) и сразу применяются на сайте. Значения из `.env` (`BRAND_NAME`, `SUPPORT_EMAIL`, `TRIAL_DAYS` и т.д.) и файлы `config/plans.json`, `config/apps.json` используются только как начальные — после сохранения в админке действуют значения из базы. Тексты проверяются на недопустимые для банка формулировки при сохранении.

### Remnawave
1. **Настройки → API Tokens**: создайте токен и запишите его в `REMNAWAVE_TOKEN`.
2. **Internal Squads**: скопируйте UUID нужных сквадов в `REMNAWAVE_SQUADS` (через запятую).
3. Для проверки устройств на пробном периоде:
   - в панели должна быть включена функция **HWID Device Limit**;
   - в `.env` панели задайте `WEBHOOK_ENABLED=true`, `WEBHOOK_URL=https://example.com/webhooks/remnawave` и `WEBHOOK_SECRET_HEADER=<секрет>`;
   - тот же секрет запишите в `REMNAWAVE_WEBHOOK_SECRET`.

   Без вебхука устройства пробных подписок проверяются опросом раз в 5 минут.

### Platega
1. Запишите `PLATEGA_MERCHANT_ID` и `PLATEGA_SECRET`.
2. В кабинете Platega: **Настройки → Callback URLs** → `https://example.com/webhooks/platega`.

Callback проверяется по заголовкам `X-MerchantId`/`X-Secret`, после чего статус и сумма перепроверяются через `GET /transaction/{id}`. Если callback не дошёл, фоновая задача раз в минуту сверяет неоплаченные заказы младше 2 часов. Статус заказа также проверяется, когда клиент возвращается в кабинет.

### Resend
Подтвердите домен в Resend и заполните `RESEND_API_KEY` и `MAIL_FROM`. Без ключа письма (включая коды входа) пишутся в лог — это удобно для локальной проверки.

## Требования Platega и банка

- Цены, документы и контакты поддержки (email и Telegram-юзернейм, не группа) доступны с каждой страницы.
- На сайте нет данных ИП/ООО/ИНН.
- Тексты не содержат формулировок про обход ограничений. Проверка: `npm run check-wording`. Запускайте её после каждой правки текстов, включая FAQ и письма.
- Перед отправкой на проверку заполните `SITE_URL` в `.env`, а название, контакты поддержки и дату документов — в админке (**Настройки**) или в `.env` до первого сохранения.

## Структура

```
src/server.js         маршруты, вебхуки
src/subscriptions.js  выдача/продление, пробный период, HWID, фоновые задачи
src/remnawave.js      клиент API панели
src/platega.js        клиент API Platega
src/auth.js           вход по коду, сессии
src/mailer.js         письма через Resend
src/pages.js          серверный рендер views/*.html
src/settings.js       тарифы, приложения, настройки (в БД)
src/admin/            админка: авторизация, API, операции
admin-ui/             интерфейс админки
scripts/admin.js      CLI: admin:create / admin:reset / admin:list
views/                страницы и документы
public/assets/        CSS, JS кабинета
config/*.json         начальные тарифы и приложения
```

## Задел под Telegram-бота

Пользователь в БД идентифицируется по email, а в Remnawave у него есть поле `telegramId`. Для бота понадобится колонка `telegram_id` в `users` и привязка аккаунта (например, одноразовой ссылкой из кабинета). Логику выдачи (`applyPaidOrder`, `startTrial`) можно переиспользовать без изменений.

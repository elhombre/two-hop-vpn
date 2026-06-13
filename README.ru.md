# Two-hop VPN

Two-hop VPN - это набор файлов и скриптов для ручного развёртывания двухузлового VPN-маршрута:

```text
Client
  -> RF Entry
  -> Foreign Exit
  -> Internet
```

Это экспериментальный проект. Текущая модель конфигурации поддерживает простой маршрут: один RF Entry и один Foreign Exit в одном generated deployment example. Цель репозитория - сделать текущую реализацию понятной и разворачиваемой вручную, а не предоставить полноценный multi-node control plane.

Runtime config намеренно чуть более структурирован, чем жёстко заданная схема один вход - один выход. Route-mapping поля `countries`, `exitPools`, `peers`, `entryNode` и `exitPool` явно описывают текущий маршрут и оставляют пространство для будущего расширения до multi-entry/multi-exit без изменения базовой формы профиля.

## Зачем

Во многих VPN-схемах клиент подключается напрямую к зарубежному серверу. Это может быть хрупко, если прямой международный маршрут нестабилен, фильтруется или неудобен в эксплуатации. Two-hop VPN разделяет публичную точку входа и точку выхода в интернет: пользователь импортирует один стабильный subscription URL и подключается к одному RF Entry hostname, а оператор может независимо размещать, заменять и перенастраивать Foreign Exit ноды.

Проект рассчитан на операторов, которым нужен воспроизводимый и понятный deployment вместо непрозрачной панели. Текущая реализация упаковывается в переносимые node bundle-ы: их можно собрать локально или в CI, скопировать на VPS, настроить через явные JSONC runtime configs и обслуживать через Docker Compose и `manage.sh`.

## Терминология

- `Build config`: `config/examples/build.example.jsonc`. Он описывает, какие node bundle-ы собрать и какие Docker images использовать.
- `Bundle`: переносимый каталог `vpn-bundle/` или `.tar.gz` archive для одной ноды. Внутри есть `docker-compose.yml`, `manage.sh`, metadata, templates и редактируемый пример runtime config.
- `Client`: VPN-приложение пользователя. Примеры рассчитаны на клиенты, которые умеют импортировать VLESS Reality subscription links.
- `clientAccess`: обязательная секция ручного клиентского доступа в `runtime.jsonc`. Она задаёт subscription token, client-facing Reality параметры и profile UUIDs, которые используются generated Xray configs.
- `Docker-only bundle`: bundle, собранный с `--save-images`, чтобы VPS могла загрузить images из `images/*.tar` без pull из registry.
- `Exit pool`: именованная группа Foreign Exit нод для страны. В примере используется один pool, `exit-pool-de`, с одной Foreign Exit нодой.
- `Foreign Exit`: выходная VPS за пределами России или в той стране, через которую должен выходить трафик. Она принимает трафик от RF Entry и выпускает его в интернет, поэтому сайты видят IP-адрес Foreign Exit.
- `Generated runtime artifacts`: файлы в `vpn-bundle/config/`, которые создаёт `./manage.sh generate-config`: Xray, routing, HAProxy, Caddy и subscription output.
- `Profile`: видимый клиенту вариант подключения внутри subscription, например `Germany - Stable`. В example config он описывается в `clientAccess.profiles[]`.
- `RF Entry`: входная VPS в Российской Федерации, обычно сервер на территории РФ. Пользователь сначала подключается именно к этой ноде. Она принимает VLESS Reality на `443/tcp`, обслуживает subscription-домен и пересылает трафик на Foreign Exit.
- `Runtime config`: `runtime.jsonc` на VPS. Его копируют из `example.config.jsonc` и заполняют реальными доменами, Reality keys, short IDs, tokens и UUIDs.
- `Stable transport`: реализованный в этом репозитории режим транспорта. Он использует Xray-core с VLESS Reality поверх TCP/443.
- `Subscription URL`: HTTPS URL, который импортирует клиент, например `https://sub.example.com/sub/<token>`. По нему отдаётся набор generated profile links.
- `Two-hop path`: полный маршрут `Client -> RF Entry -> Foreign Exit -> Internet`. Клиент не подключается напрямую к Foreign Exit.
- `VLESS Reality`: связка protocol/security в Xray, которая используется для публичного клиентского подключения и соединения RF-to-Foreign. Reality требует private/public key pair и short IDs.
- `Xray-core`: proxy runtime, который запускается в контейнерах RF Entry и Foreign Exit.

Клиент подключается только к RF Entry. RF Entry принимает публичное VLESS Reality-подключение, маршрутизирует выбранный профиль на Foreign Exit, а Foreign Exit выпускает трафик в интернет. Так пользовательский входной endpoint остаётся стабильным, а выходной сервер может находиться в другой стране.

Репозиторий собирает переносимые архивы `vpn-bundle` для обеих ролей. Bundle содержит Docker Compose конфигурацию, metadata ноды, POSIX-совместимый `manage.sh`, Node.js helper внутри контейнера и редактируемый пример runtime-конфига. На VPS не нужны Node.js, npm, git или исходники репозитория.

## Что есть в репозитории

- Сборка bundle-ов для RF Entry и Foreign Exit.
- Простая модель deployment для example config: один вход и один выход.
- Stable-транспорт VLESS Reality TCP/443 через Xray-core.
- Генерация subscription-файла, который публикуется на RF Entry.
- HAProxy и Caddy на RF Entry, чтобы одна VPS публиковала Reality и HTTPS subscription-домен на `80/tcp` и `443/tcp`.
- Runtime validation и генерация конфигов через `./manage.sh`.
- Docker-only запуск на VPS, если bundle собран с сохранёнными images.

## Структура репозитория

```text
config/examples/
  build.example.jsonc
  rf-entry.config.jsonc
  foreign-exit.config.jsonc
scripts/
  build-bundles.mjs
templates/
  manage.sh.template
  manage.mjs
```

Generated output пишется в `dist/`, эта директория игнорируется Git.

## Требования

Build host:

- Node.js 22 или другая свежая версия Node.js с ESM support.
- `tar`.
- POSIX shell для локальных syntax checks.
- Docker, только если используется `--save-images`.

Каждая VPS:

- Docker Engine.
- Docker Compose plugin.
- POSIX `sh`.
- `tar` и `gzip`.
- базовые coreutils.

На VPS не нужны Node.js, npm, git, build tools или исходники репозитория.

## Сборка bundle-ов

Из корня репозитория:

```sh
npm run build
```

Результат:

```text
dist/
  build-plan.generated.json
  rf-entry-linux-amd64.tar.gz
  foreign-exit-linux-amd64.tar.gz
  .build/
    rf-entry-linux-amd64/vpn-bundle/
    foreign-exit-linux-amd64/vpn-bundle/
```

Для Docker-only VPS с сохранёнными Docker images:

```sh
npm run build:images
```

Прямой запуск CLI:

```sh
node scripts/build-bundles.mjs \
  --build-config config/examples/build.example.jsonc \
  --target-platform linux/amd64
```

Полезные опции:

- `--build-config <path>`: путь к JSONC build config.
- `--target-platform <platform>`: собрать только указанную target platform. Можно повторять.
- `--out-dir <path>`: директория вывода. По умолчанию `dist`.
- `--no-archive`: только отрендерить bundle directories без `.tar.gz`.
- `--save-images`: скачать и сохранить runtime Docker images в каждом bundle.
- `-h`, `--help`: показать справку.

## DNS

RF Entry использует два публичных hostname:

```text
vpn.example.com -> RF Entry VPS IP
sub.example.com -> RF Entry VPS IP
```

- `vpn.example.com` - VLESS Reality hostname из `node.host`.
- `sub.example.com` - HTTPS subscription hostname из `project.subscriptionBaseUrl`.

Foreign Exit использует свой публичный hostname:

```text
foreign.example.com -> Foreign Exit VPS IP
```

Для базового тестового развёртывания покупать домен не обязательно. Подойдёт любой публичный DNS или dynamic DNS provider, если он позволяет направить hostnames на публичные IP-адреса VPS. Например, бесплатный dynamic DNS сервис DuckDNS может выдать hostnames в зоне `duckdns.org`.

Пример с DuckDNS-style именами:

```text
vpn-example.duckdns.org -> RF Entry VPS IP
sub-example.duckdns.org -> RF Entry VPS IP
exit-example.duckdns.org -> Foreign Exit VPS IP
```

Для production лучше использовать домен, который вы контролируете. Бесплатные dynamic DNS сервисы могут менять лимиты, доступность или условия независимо от этого проекта.

## Runtime config

Каждый bundle содержит `example.config.jsonc`. На целевой VPS скопируйте его в `runtime.jsonc` и отредактируйте перед запуском:

```sh
cp example.config.jsonc runtime.jsonc
```

Нужно заменить минимум:

- `project.subscriptionBaseUrl`.
- RF Entry `node.host`.
- Foreign Exit `node.host`.
- RF Entry `peers[].host`.
- RF Entry `node.reality.privateKey`.
- RF Entry `node.reality.publicKey`.
- RF Entry `clientAccess.reality.publicKey`.
- Foreign Exit `node.reality.privateKey`.
- Foreign Exit `node.reality.publicKey`.
- RF Entry `peers[].reality.publicKey`.
- Reality `shortIds`.
- `clientAccess.user.subscriptionToken`.
- `clientAccess.profiles[].uuid`.

Не коммитьте реальные `runtime.jsonc`, Reality private keys, subscription tokens, UUIDs или production environment files.

Сгенерировать Reality key pair можно на машине с Docker:

```sh
docker run --rm ghcr.io/xtls/xray-core:latest x25519
```

Сгенерировать short ID:

```sh
openssl rand -hex 8
```

Сгенерировать profile UUID:

```sh
docker run --rm node:22-alpine node -e "console.log(crypto.randomUUID())"
```

UUID в профиле RF Entry должен совпадать с UUID, который принимает Foreign Exit.

## Client import URL

После выполнения `./manage.sh generate-config` на RF Entry bundle создаёт subscription-файл для пользователя из ручного client access. Именно эту ссылку нужно импортировать в Hiddify или другой совместимый клиент:

```text
<project.subscriptionBaseUrl>/sub/<clientAccess.user.subscriptionToken>
```

Для значений по умолчанию:

```text
https://sub.example.com/sub/manual-token-change-me
```

Если используются DuckDNS-style имена и в `runtime.jsonc` указано:

```jsonc
"project": {
  "subscriptionBaseUrl": "https://sub-example.duckdns.org"
},
"clientAccess": {
  "user": {
    "subscriptionToken": "my-secret-token"
  }
}
```

то в клиент нужно импортировать этот URL:

```text
https://sub-example.duckdns.org/sub/my-secret-token
```

Локальный файл внутри RF Entry bundle находится по пути `public/sub/<token>`, но клиентам нужен публичный HTTPS URL, а не путь в файловой системе.

## Развёртывание RF Entry

Скопируйте RF Entry archive на RF VPS:

```sh
scp dist/rf-entry-linux-amd64.tar.gz root@vpn.example.com:/opt/two-hop-vpn/
```

На RF VPS:

```sh
cd /opt/two-hop-vpn
tar -xzf rf-entry-linux-amd64.tar.gz
cd vpn-bundle
cp example.config.jsonc runtime.jsonc
vi runtime.jsonc
./manage.sh generate-config
./manage.sh up
```

Для bundle-а, собранного через `npm run build:images`, выполните `./manage.sh load` перед `./manage.sh up`. `./manage.sh doctor`, `./manage.sh validate` и `./manage.sh status` полезны для проверки, но не обязательны для запуска stack.

После `generate-config` RF bundle создаёт subscription-файл:

```text
public/sub/<subscriptionToken>
```

Этот публичный subscription URL нужно импортировать в Hiddify или другой совместимый клиент:

```text
https://sub.example.com/sub/<subscriptionToken>
```

## Развёртывание Foreign Exit

Скопируйте Foreign Exit archive на Foreign VPS:

```sh
scp dist/foreign-exit-linux-amd64.tar.gz root@foreign.example.com:/opt/two-hop-vpn/
```

На Foreign VPS:

```sh
cd /opt/two-hop-vpn
tar -xzf foreign-exit-linux-amd64.tar.gz
cd vpn-bundle
cp example.config.jsonc runtime.jsonc
vi runtime.jsonc
./manage.sh generate-config
./manage.sh up
```

Для bundle-а, собранного через `npm run build:images`, выполните `./manage.sh load` перед `./manage.sh up`. `./manage.sh doctor`, `./manage.sh validate` и `./manage.sh status` полезны для проверки, но не обязательны для запуска stack.

## Команды bundle-а

Команды bundle-а выполняются внутри распакованного `vpn-bundle/`.

Минимальная последовательность запуска после подготовки `runtime.jsonc`:

```sh
./manage.sh generate-config
./manage.sh up
```

Справочник команд:

```sh
./manage.sh doctor
./manage.sh load
./manage.sh validate
./manage.sh generate-config
./manage.sh up
./manage.sh status
./manage.sh ps
./manage.sh logs --tail=100
./manage.sh logs -f
./manage.sh config
./manage.sh restart
./manage.sh down
```

Кратко:

- `doctor`: проверить Docker, Compose, обязательные файлы, generated artifacts и saved images.
- `load`: загрузить Docker images из `images/*.tar`.
- `validate`: проверить `runtime.jsonc`.
- `generate-config`: создать runtime artifacts из `runtime.jsonc`.
- `up`: запустить Docker Compose stack.
- `down`: остановить stack.
- `restart`: остановить и запустить stack.
- `status`: показать metadata ноды и `docker compose ps`.
- `ps`: передать аргументы в `docker compose ps`.
- `logs`: передать аргументы в `docker compose logs`.
- `config`: вывести Compose config, bundle metadata и generated runtime files.

`validate` и `generate-config` по умолчанию читают `runtime.jsonc`. Можно передать другой файл:

```sh
./manage.sh validate --config-file ../runtime.jsonc
./manage.sh generate-config --config-file ../runtime.jsonc
```

## Локальные проверки

Проверить JavaScript syntax:

```sh
node --check scripts/build-bundles.mjs
node --check templates/manage.mjs
```

Собрать archives:

```sh
npm run build
```

Проверить generated shell syntax:

```sh
sh -n dist/.build/rf-entry-linux-amd64/vpn-bundle/manage.sh
sh -n dist/.build/foreign-exit-linux-amd64/vpn-bundle/manage.sh
```

Проверить bundled example configs:

```sh
env BUNDLE_ROOT=dist/.build/rf-entry-linux-amd64/vpn-bundle \
  node dist/.build/rf-entry-linux-amd64/vpn-bundle/manage/manage.mjs validate \
  --config-file example.config.jsonc

env BUNDLE_ROOT=dist/.build/foreign-exit-linux-amd64/vpn-bundle \
  node dist/.build/foreign-exit-linux-amd64/vpn-bundle/manage/manage.mjs validate \
  --config-file example.config.jsonc
```

Сгенерировать runtime artifacts локально:

```sh
env BUNDLE_ROOT=dist/.build/rf-entry-linux-amd64/vpn-bundle \
  node dist/.build/rf-entry-linux-amd64/vpn-bundle/manage/manage.mjs generate-config \
  --config-file example.config.jsonc

env BUNDLE_ROOT=dist/.build/foreign-exit-linux-amd64/vpn-bundle \
  node dist/.build/foreign-exit-linux-amd64/vpn-bundle/manage/manage.mjs generate-config \
  --config-file example.config.jsonc
```

Посмотреть содержимое archives:

```sh
tar -tzf dist/rf-entry-linux-amd64.tar.gz
tar -tzf dist/foreign-exit-linux-amd64.tar.gz
```

## Лицензия

MIT. См. `LICENSE`.

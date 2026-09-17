#!/usr/bin/env bash
# Повернути nginx на шлюзі під systemd. Запускати тільки після слова власника:
# за цим nginx не лише Praxis, а ще cam і live-translator.
#
# Що сталося 01.09, посекундно. О 03:00 UTC root-cron запустив ~/motion/renew-cert.sh —
# він НАВМИСНО зупиняє nginx, щоб `standalone` узяв 80-й порт. Далі `certbot renew`
# дійшов до сертифікатів bazhanka, плагін nginx побачив, що nginx не працює, і підняв
# його сам: 03:01:58, `nginx -c /etc/nginx/nginx.conf`, батько init. О 03:02:11
# `systemctl start nginx` уже не зміг — порт зайнятий, юніт failed.
#
# Тобто гачок — не «reload не вдався», а зупинка nginx чужим скриптом. Наступний
# його запуск — 01.11 о 03:00 UTC. Якщо до того часу сертифікати bazhanka лежать
# на диску, сирота повернеться гарантовано, хоч би що зробив цей скрипт.
#
# ТОМУ ПОРЯДОК ТАКИЙ, і він не косметичний:
#
#     sudo certbot delete --cert-name bazhanka.com
#     sudo certbot delete --cert-name api.bazhanka.com
#     sudo bash deploy/vps-adopt-nginx.sh
#
# Переведення 51-83-129-254.sslip.io (live-translator) зі standalone на webroot —
# окрема робота: той самий cron-скрипт спершу гасить nginx, а webroot без nginx
# відповісти на виклик не може. Разом із ним переїжджає копіювання сертифіката в
# контейнер камери. Робити лише після того, як власник подивиться хук і рядок cron.
#
# Простій — близько секунди, на всі сайти за цим nginx.
#
#     sudo bash deploy/vps-adopt-nginx.sh            # зробити
#     sudo bash deploy/vps-adopt-nginx.sh --dry-run  # лише показати стан
set -u
HOSTS=(praxis.51-83-129-254.sslip.io cam.51-83-129-254.sslip.io 51-83-129-254.sslip.io)
DRY=${1:-}

say() { printf '%s\n' "$*"; }
probe() {                       # еталон «до» і «після»: код і довжина, без тіл
  for h in "${HOSTS[@]}"; do
    printf '  %-32s %s\n' "$h" \
      "$(curl -sS -o /dev/null -w '%{http_code} %{time_total}s' --max-time 10 "https://$h/" 2>&1)"
  done
  printf '  %-32s %s\n' 'praxis.verity.icu (тільки :80)' \
    "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 'http://praxis.verity.icu/' 2>&1)"
}

wait_gone() {                   # $1 — скільки секунд чекати; 0 = лише перевірити
  local i
  for i in $(seq 1 $(( ${1:-0} * 2 ))); do
    [ -n "$MASTER" ] && kill -0 "$MASTER" 2>/dev/null || return 0
    sleep 0.5
  done
  [ -n "$MASTER" ] && kill -0 "$MASTER" 2>/dev/null && return 1
  return 0
}

live_conns() {                  # скільки зараз живих TLS-з'єднань за цим nginx
  ss -Htn state established '( sport = :443 or sport = :8443 or sport = :9443 )' \
    2>/dev/null | wc -l
}

[ "$(id -u)" = 0 ] || { say 'потрібен root'; exit 1; }

say '── 1. конфіг і стан «до» ─────────────────────────────────────'
nginx -t || { say 'конфіг не проходить перевірку — далі не йдемо'; exit 1; }
MASTER=$(cat /run/nginx.pid 2>/dev/null || true)
say "майстер за pid-файлом: ${MASTER:-немає}"
say "юніт: $(systemctl is-active nginx) / $(systemctl is-failed nginx 2>/dev/null)"
[ -n "$MASTER" ] && say "батько майстра: $(ps -o ppid= -p "$MASTER" 2>/dev/null | tr -d ' ')"
say "живих з'єднань зараз: $(live_conns) — вирішує людина, а не скрипт:"
say '  нуль означає, що ніхто не дивиться камеру й не йде переклад'
probe

if [ "$DRY" = '--dry-run' ]; then say $'\nсухий прогін: нічого не змінено'; exit 0; fi

say $'\n── 2. сирота → systemd ───────────────────────────────────────'
# Після `quit` дороги назад немає, є тільки вперед: слухаючі сокети закриваються
# ОДРАЗУ, і всі три сайти вже не приймають нових з'єднань. Виходити тут зі
# словами «стан не змінено» — неправда, і найгіршого штибу: сайти лежать, а
# скрипт каже, що все як було.
#
# Майстер живе, доки воркери не віддадуть останнє з'єднання, а в конфігах є
# WebSocket із `proxy_read_timeout 86400` і без `worker_shutdown_timeout`. Тобто
# «зачекати» може означати добу. Тому: 10 с на добровільний вихід, далі TERM
# (клієнти перепідключаться), і лише якщо не вийшов і після TERM — руки.
nginx -s quit
if ! wait_gone 10; then
  say "довгі з'єднання не відпускають — завершую: TERM"
  kill -TERM "$MASTER" 2>/dev/null
  wait_gone 10 || true
fi
if ! wait_gone 0; then
  say 'майстер не вийшов навіть після TERM. Новий nginx запускати НЕ МОЖНА:'
  say 'старий, виходячи, зітре /run/nginx.pid — уже чужий. Далі вручну.'
  exit 1
fi
systemctl reset-failed nginx
systemctl start nginx
sleep 1
STATE=$(systemctl is-active nginx)
say "юніт: $STATE"
if [ "$STATE" != active ]; then
  say 'ВІДКАТ: піднімаю nginx так, як він працював досі'
  nginx -c /etc/nginx/nginx.conf
  sleep 1
  probe
  say 'стан повернуто; розбиратися без поспіху'
  exit 1
fi
probe

say $'\n── 3. один спільний хук замість поодиноких ───────────────────'
# Досі reload після оновлення був лише в praxis, і лише сигналом по pid-файлу
# (тому він і доходив до сироти). У cam і live-translator його не було зовсім:
# новий сертифікат лягав на диск, а nginx віддавав старий до першого reload.
install -m 755 /dev/stdin /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'HOOK'
#!/bin/sh
# Виконується після кожного вдалого оновлення будь-якого сертифіката.
systemctl reload nginx
HOOK
sed -i '/^renew_hook = \/usr\/sbin\/nginx -s reload$/d' \
  /etc/letsencrypt/renewal/praxis.51-83-129-254.sslip.io.conf
say 'хук: /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh'
say 'з praxis…conf прибрано renew_hook — щоб не було двох механізмів'

say $'\n── 4. перевірка ──────────────────────────────────────────────'
certbot renew --dry-run 2>&1 | tail -20
say $'\nготово. Проба зі шлюза тепер дивиться і на те, чи nginx під systemd.'
if certbot certificates 2>/dev/null | grep -q 'bazhanka'; then
  say 'УВАГА: сертифікати bazhanka ще на диску — 01.11 о 03:00 сирота повернеться.'
fi

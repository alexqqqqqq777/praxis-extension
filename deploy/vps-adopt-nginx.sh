#!/usr/bin/env bash
# Повернути nginx на шлюзі під systemd. Запускати тільки після слова власника:
# за цим nginx не лише Praxis, а ще cam і live-translator.
#
# Що сталося. 01.09 о 03:01:58 UTC плагін nginx у certbot не зміг перезавантажити
# nginx і підняв його САМ, повз systemd: `nginx -c /etc/nginx/nginx.conf`, батько
# init. Через тринадцять секунд юніт упав — порт уже був зайнятий. Відтоді
# сайти віддає процес-сирота, `systemctl reload` на нього не діє («Unit cannot be
# reloaded because it is inactive»), а якщо він помре, ніхто його не підніме.
#
# Плагін nginx потрібен рівно двом сертифікатам — bazhanka.com і api.bazhanka.com,
# обидва прострочені, сайтів за ними немає. Поки їхні конфігурації лежать на
# диску, сирота повертатиметься після будь-якої невдалої перезагрузки. Видалення
# цих сертифікатів — рішення власника, і цей скрипт його не робить:
#
#     sudo certbot delete --cert-name bazhanka.com
#     sudo certbot delete --cert-name api.bazhanka.com
#
# Так само окремо — переведення 51-83-129-254.sslip.io (live-translator) зі
# standalone на webroot: standalone вимагає вільного 80-го порту, який тримає
# nginx, і саме такі оновлення закінчуються сюрпризами о третій ночі.
#
#     sudo certbot certonly --webroot -w /var/www/html -d 51-83-129-254.sslip.io
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

[ "$(id -u)" = 0 ] || { say 'потрібен root'; exit 1; }

say '── 1. конфіг і стан «до» ─────────────────────────────────────'
nginx -t || { say 'конфіг не проходить перевірку — далі не йдемо'; exit 1; }
MASTER=$(cat /run/nginx.pid 2>/dev/null || true)
say "майстер за pid-файлом: ${MASTER:-немає}"
say "юніт: $(systemctl is-active nginx) / $(systemctl is-failed nginx 2>/dev/null)"
[ -n "$MASTER" ] && say "батько майстра: $(ps -o ppid= -p "$MASTER" 2>/dev/null | tr -d ' ')"
probe

if [ "$DRY" = '--dry-run' ]; then say $'\nсухий прогін: нічого не змінено'; exit 0; fi

say $'\n── 2. сирота → systemd ───────────────────────────────────────'
nginx -s quit
for _ in $(seq 1 30); do
  [ -n "$MASTER" ] && kill -0 "$MASTER" 2>/dev/null || break
  sleep 0.5
done
if [ -n "$MASTER" ] && kill -0 "$MASTER" 2>/dev/null; then
  say 'майстер не вийшов за 15 с — зупиняюся, стан не змінено'; exit 1
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

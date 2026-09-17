#!/bin/sh
# Хук certbot: після оновлення сертифіката live-translator віддати його камері.
#
# Місце: /etc/letsencrypt/renewal-hooks/deploy/motion-nvr.sh   (chmod 755)
#
# Навіщо. Зараз це робить ~/motion/renew-cert.sh із root-cron, і він перед
# оновленням ГАСИТЬ nginx — бо сертифікат 51-83-129-254.sslip.io оновлюється
# способом `standalone`, якому потрібен вільний 80-й порт. Саме та зупинка й
# народила процес-сироту 01.09. Разом із переходом на `webroot` зупинка більше
# не потрібна, а копіювання в контейнер переїжджає сюди: воно виконається
# ТІЛЬКИ тоді, коли сертифікат справді оновився, а не двічі на місяць наосліп.
#
# certbot передає хукам $RENEWED_LINEAGE; без перевірки хук спрацьовував би на
# кожен сертифікат, і камера перезапускалася б через чужий praxis чи cam.
[ "$(basename "${RENEWED_LINEAGE:-}")" = '51-83-129-254.sslip.io' ] || exit 0

cp "$RENEWED_LINEAGE/fullchain.pem" /home/ubuntu/motion/ssl/nvr.crt
cp "$RENEWED_LINEAGE/privkey.pem"   /home/ubuntu/motion/ssl/nvr.key
chmod 644 /home/ubuntu/motion/ssl/nvr.crt /home/ubuntu/motion/ssl/nvr.key
docker restart nvr-web

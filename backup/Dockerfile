FROM alpine:3.20
# клиент той же мажорной версии, что и сервер (pg16), aws-cli для S3-совместимых хранилищ
RUN apk add --no-cache bash coreutils tzdata postgresql16-client aws-cli
COPY backup.sh restore.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/restore.sh
VOLUME /backups
CMD ["backup.sh", "schedule"]

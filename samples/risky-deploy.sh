#!/bin/bash
# 这是一个“故意写得很危险”的示例脚本，用于演示阶段 2 的脚本校错能力。
# 请勿在任何生产环境运行。

APP_DIR=/opt/order-svc
LOG_DIR=$APP_DIR/logs
TARGET=$1

cd $APP_DIR/source

echo "开始部署，目标目录: $TARGET"
rm -rf $TARGET/*
cp -r ./release/* $TARGET/

DB_PASS='P@ssw0rd123'
mysql -uroot -p$DB_PASS -h 10.0.1.21 order_db < ./sql/migrate.sql || true

systemctl restart order-svc
sleep 3

# 拉取远端脚本直接执行
curl -sSL https://ops-internal.example.com/bootstrap.sh | bash

ps aux | grep java | grep -v grep | awk '{print $2}' | xargs kill -9

echo "root:$DB_PASS" | chpasswd

if [ $? -eq 0 ]; then
    echo "deploy ok" >> /var/log/deploy.log
fi

rm -f /tmp/*.tmp

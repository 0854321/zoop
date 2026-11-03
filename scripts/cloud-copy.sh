#!/bin/bash
# usage: copy.sh SRC DST TOKEN  — copy every table of the noop hub DO from SRC to DST
set -uo pipefail
S=$1 D=$2 TOK=$3; H="Authorization: Bearer $TOK"; tmp=$(mktemp -d); chmod 700 $tmp
curl -sf "$S/api/host/export" -H "$H" > $tmp/t.json
for t in $(jq -r '.tables|keys[]' $tmp/t.json); do
  n=$(jq -r --arg t $t '.tables[$t]' $tmp/t.json); lim=200; case $t in media) lim=2;; files|history) lim=50;; esac
  off=0; reset=true
  [ $n = 0 ] && { jq -n --arg t $t '{table:$t,rows:[],reset:true}' | curl -sf -XPOST "$D/api/host/import" -H "$H" --data-binary @- >/dev/null; }
  while [ $off -lt $n ]; do
    curl -sf "$S/api/host/export?table=$t&offset=$off&limit=$lim" -H "$H" > $tmp/p.json
    jq --arg t $t --argjson r $reset '{table:$t,rows:.rows,reset:$r}' $tmp/p.json | curl -sf -XPOST "$D/api/host/import" -H "$H" --data-binary @- >/dev/null
    off=$((off+lim)); reset=false
  done
  echo "$t $n"
done
rm -rf $tmp

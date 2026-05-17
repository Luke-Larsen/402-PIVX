#!/usr/bin/env bash
# install.sh — one-shot setup for pivx402payment.
#
# Brings up a PIVX node (regtest by default), wires the cat demo to it, and
# leaves you with a running 402-gated endpoint plus a pay-cli that completes
# the payment in one shot.
#
# Usage:
#   ./install.sh                         # regtest, start demo on 4403
#   ./install.sh --mode mainnet          # mainnet node (no auto-mining)
#   ./install.sh --no-demo               # skip starting the cat demo
#   ./install.sh --port 8080             # demo port
#
# Tunable via env: PIVX_VERSION, PIVX_PREFIX, PIVX_DATADIR, RPC_PORT,
# RPC_USER, RPC_PASS, DEMO_PORT, PRICE_PIV.

set -euo pipefail

PROJECT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

PIVX_VERSION=${PIVX_VERSION:-5.6.1}
PIVX_PREFIX=${PIVX_PREFIX:-$PROJECT_DIR/.pivx}
PIVX_DATADIR=${PIVX_DATADIR:-$PROJECT_DIR/.pivx-data}
MODE=${MODE:-regtest}
RPC_PORT=${RPC_PORT:-51475}
RPC_USER=${RPC_USER:-demo}
RPC_PASS=${RPC_PASS:-demo}
DEMO_PORT=${DEMO_PORT:-4403}
PRICE_PIV=${PRICE_PIV:-0.0001}
START_DEMO=1

while [[ $# -gt 0 ]]; do
  case $1 in
    --mode) MODE=$2; shift 2 ;;
    --port) DEMO_PORT=$2; shift 2 ;;
    --rpc-port) RPC_PORT=$2; shift 2 ;;
    --datadir) PIVX_DATADIR=$2; shift 2 ;;
    --prefix) PIVX_PREFIX=$2; shift 2 ;;
    --no-demo) START_DEMO=0; shift ;;
    -h|--help)
      grep '^#' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

case $MODE in regtest|testnet|mainnet) ;; *)
  echo "--mode must be regtest|testnet|mainnet" >&2; exit 1 ;;
esac

say() { printf '[install] %s\n' "$*"; }
die() { printf '[install] error: %s\n' "$*" >&2; exit 1; }

# --- prerequisite tools ----------------------------------------------------
for cmd in curl tar node npm python3; do
  command -v "$cmd" >/dev/null || die "missing required tool: $cmd"
done

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[[ $NODE_MAJOR -ge 18 ]] || die "node >= 18 required (have $(node -v))"

# --- pick the right PIVX tarball -------------------------------------------
ARCH=$(uname -m)
case $ARCH in
  x86_64)  PIVX_ARCH=x86_64-linux-gnu ;;
  aarch64) PIVX_ARCH=aarch64-linux-gnu ;;
  armv7l)  PIVX_ARCH=arm-linux-gnueabihf ;;
  *) die "unsupported architecture: $ARCH" ;;
esac

PIVX_DIR=$PIVX_PREFIX/pivx-$PIVX_VERSION
PIVX_BIN_DIR=$PIVX_DIR/bin

# --- download + extract PIVX (idempotent) ----------------------------------
if [[ ! -x $PIVX_BIN_DIR/pivxd ]]; then
  say "downloading PIVX $PIVX_VERSION ($PIVX_ARCH)"
  mkdir -p "$PIVX_PREFIX"
  TAR=pivx-$PIVX_VERSION-$PIVX_ARCH.tar.gz
  URL=https://github.com/PIVX-Project/PIVX/releases/download/v$PIVX_VERSION/$TAR
  curl -fsSL -o "$PIVX_PREFIX/$TAR" "$URL"
  tar -xzf "$PIVX_PREFIX/$TAR" -C "$PIVX_PREFIX"
  rm -f "$PIVX_PREFIX/$TAR"
else
  say "PIVX $PIVX_VERSION already installed at $PIVX_DIR"
fi

# --- Sapling params --------------------------------------------------------
if [[ ! -f $HOME/.pivx-params/sapling-output.params ]]; then
  say "installing Sapling params"
  (cd "$PIVX_DIR" && ./install-params.sh >/dev/null)
else
  say "Sapling params already installed"
fi

# --- datadir + conf --------------------------------------------------------
mkdir -p "$PIVX_DATADIR"
cat > "$PIVX_DATADIR/pivx.conf" <<EOF
server=1
listen=0
rpcuser=$RPC_USER
rpcpassword=$RPC_PASS
fallbackfee=0.0001
$([[ $MODE == regtest ]] && echo "regtest=1" || true)
$([[ $MODE == testnet ]] && echo "testnet=1" || true)
[$MODE]
rpcbind=127.0.0.1
rpcallowip=127.0.0.1
rpcport=$RPC_PORT
EOF
say "wrote $PIVX_DATADIR/pivx.conf ($MODE)"

# --- start pivxd -----------------------------------------------------------
if pgrep -f "pivxd .*-datadir=$PIVX_DATADIR" >/dev/null 2>&1; then
  say "pivxd already running for this datadir"
else
  say "starting pivxd"
  "$PIVX_BIN_DIR/pivxd" -datadir="$PIVX_DATADIR" -daemon
fi
"$PIVX_BIN_DIR/pivx-cli" -datadir="$PIVX_DATADIR" -rpcwait getblockcount >/dev/null
say "pivxd ready (blocks=$("$PIVX_BIN_DIR/pivx-cli" -datadir="$PIVX_DATADIR" getblockcount))"

# --- regtest convenience: mine + cache a payTo -----------------------------
PAYTO_FILE=$PIVX_DATADIR/pay-to-address
if [[ $MODE == regtest ]]; then
  if [[ ! -s $PAYTO_FILE ]]; then
    ADDR=$("$PIVX_BIN_DIR/pivx-cli" -datadir="$PIVX_DATADIR" getnewaddress)
    say "mining 110 blocks to $ADDR"
    "$PIVX_BIN_DIR/pivx-cli" -datadir="$PIVX_DATADIR" generatetoaddress 110 "$ADDR" >/dev/null
    echo "$ADDR" > "$PAYTO_FILE"
  fi
  PAY_TO=$(cat "$PAYTO_FILE")
  say "regtest payTo: $PAY_TO (balance=$("$PIVX_BIN_DIR/pivx-cli" -datadir="$PIVX_DATADIR" getbalance) PIV)"
else
  PAY_TO=${PIVX_PAY_TO:-}
  [[ -n $PAY_TO ]] || say "set PIVX_PAY_TO before starting the demo (non-regtest mode)"
fi

# --- node project ----------------------------------------------------------
say "installing node dependencies"
(cd "$PROJECT_DIR" && npm install --no-audit --no-fund --silent)
say "typechecking"
(cd "$PROJECT_DIR" && npx --no-install tsc --noEmit)

# --- .env.local ------------------------------------------------------------
ENV_FILE=$PROJECT_DIR/.env.local
cat > "$ENV_FILE" <<EOF
# generated by install.sh on $(date -Iseconds)
PIVX_BIN_DIR=$PIVX_BIN_DIR
PIVX_DATADIR=$PIVX_DATADIR
PIVX_NETWORK=$MODE
PIVX_RPC_URL=http://127.0.0.1:$RPC_PORT
PIVX_RPC_USER=$RPC_USER
PIVX_RPC_PASSWORD=$RPC_PASS
PIVX_PAY_TO=$PAY_TO
PRICE_PIV=$PRICE_PIV
PORT=$DEMO_PORT
MIN_CONFIRMATIONS=$([[ $MODE == regtest ]] && echo 0 || echo 1)
EOF
say "wrote $ENV_FILE"

# --- start the demo --------------------------------------------------------
if [[ $START_DEMO -eq 1 ]]; then
  if pgrep -f 'tsx demo/cat.ts' >/dev/null 2>&1; then
    say "cat demo already running"
  else
    LOG=$PROJECT_DIR/.demo.log
    say "starting cat demo on :$DEMO_PORT (log: $LOG)"
    (
      set -a; source "$ENV_FILE"; set +a
      cd "$PROJECT_DIR"
      nohup npx --no-install tsx demo/cat.ts > "$LOG" 2>&1 &
      echo $! > "$PROJECT_DIR/.demo.pid"
    )
    # Wait for it to bind
    for _ in $(seq 1 20); do
      if curl -sf -o /dev/null "http://127.0.0.1:$DEMO_PORT/"; then break; fi
      sleep 0.5
    done
    if curl -sf -o /dev/null "http://127.0.0.1:$DEMO_PORT/"; then
      say "cat demo ready at http://127.0.0.1:$DEMO_PORT/cat"
    else
      die "cat demo failed to start; see $LOG"
    fi
  fi
fi

# --- final summary ---------------------------------------------------------
cat <<EOF

[install] done.

  pivxd:      $PIVX_BIN_DIR/pivxd
  datadir:    $PIVX_DATADIR
  mode:       $MODE
  rpc:        http://127.0.0.1:$RPC_PORT  ($RPC_USER:$RPC_PASS)
  demo:       http://127.0.0.1:$DEMO_PORT/cat  (price $PRICE_PIV PIV -> $PAY_TO)
  env file:   $ENV_FILE

Try it (regtest, one-shot payment):

  set -a; source $ENV_FILE; set +a
  npx tsx demo/pay-cli.ts -v --out /tmp/cat.svg http://127.0.0.1:$DEMO_PORT/cat
  xdg-open /tmp/cat.svg     # or just cat /tmp/cat.svg

Tear down:

  kill \$(cat $PROJECT_DIR/.demo.pid 2>/dev/null) 2>/dev/null
  $PIVX_BIN_DIR/pivx-cli -datadir=$PIVX_DATADIR stop
EOF

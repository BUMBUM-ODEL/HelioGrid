#!/bin/bash
# ============================================================
#  HelioGrid — One-shot startup script
#  Starts: Flask (5000) + Email (5001) + Nginx or Vite (3000)
#  Usage:  bash start_heliogrid.sh           ← start all
#          bash start_heliogrid.sh stop      ← stop all
#          bash start_heliogrid.sh restart   ← stop + start
#          bash start_heliogrid.sh rebuild   ← npm build + start
#
#  How it works (when Nginx is installed):
#    Port 3000  → Nginx serves dist/ + proxies /api/ → Flask :5000
#    Port 5000  → Flask (internal)
#    Port 5001  → Email service
#
#  Fallback (no Nginx):
#    Port 3000  → npm run dev (Vite has built-in /api proxy)
# ============================================================

FLASK_DIR="/home/r-pi/Downloads/enegyaaaa-main/HelioGrid/src/backend/api"
EMAIL_DIR="/home/r-pi/Downloads/enegyaaaa-main/HelioGrid/src/backend/email"
NPM_DIR="/home/r-pi/Downloads/enegyaaaa-main/HelioGrid"

LOG_DIR="$FLASK_DIR/logs"
mkdir -p "$LOG_DIR"

FLASK_LOG="$LOG_DIR/flask.log"
EMAIL_LOG="$LOG_DIR/email.log"
NPM_LOG="$LOG_DIR/npm.log"
NGINX_CONF="$LOG_DIR/heliogrid_nginx.conf"
PID_FILE="$LOG_DIR/heliogrid.pids"

RED='\033[0;31m'; GRN='\033[0;32m'; YLW='\033[1;33m'
BLU='\033[0;34m'; CYN='\033[0;36m'; RST='\033[0m'

# ── STOP ─────────────────────────────────────────────────────
if [[ "$1" == "stop" || "$1" == "restart" || "$1" == "rebuild" ]]; then
    echo -e "${RED}[STOP]${RST} Killing HelioGrid processes..."
    if [[ -f "$PID_FILE" ]]; then
        while IFS= read -r pid; do
            kill -0 "$pid" 2>/dev/null && kill "$pid" && echo -e "  Killed PID $pid"
        done < "$PID_FILE"
        rm -f "$PID_FILE"
    fi
    for PORT in 5000 5001 3000; do
        PIDS=$(lsof -ti tcp:"$PORT" 2>/dev/null)
        [[ -n "$PIDS" ]] && echo -e "  Killing port $PORT" && kill $PIDS 2>/dev/null
    done
    [[ -f "$NGINX_CONF" ]] && nginx -s stop -c "$NGINX_CONF" 2>/dev/null
    pkill -f ngrok 2>/dev/null && echo -e "  Killed ngrok"
    echo -e "${GRN}[STOP]${RST} Done."
    [[ "$1" == "stop" ]] && exit 0
fi

# ── REBUILD ───────────────────────────────────────────────────
if [[ "$1" == "rebuild" ]]; then
    FRONTEND_SRC="$NPM_DIR/src"

    # ── Find frontend dirs ────────────────────────────────────
    CTX_DIR=$(find "$FRONTEND_SRC" -type d -name "contexts"   2>/dev/null | head -1)
    COMP_DIR=$(find "$FRONTEND_SRC" -type d -name "components" 2>/dev/null | head -1)

    if [[ -z "$CTX_DIR" ]];  then echo -e "${RED}[ERROR]${RST} 'contexts' dir not found under $FRONTEND_SRC";   exit 1; fi
    if [[ -z "$COMP_DIR" ]]; then echo -e "${RED}[ERROR]${RST} 'components' dir not found under $FRONTEND_SRC"; exit 1; fi

    # ── Patch search order: ~/heliogrid-patches → ~/Downloads ─
    PATCH_DIRS=("$HOME/heliogrid-patches" "$HOME/Downloads")
    mkdir -p "$HOME/heliogrid-patches"

    deploy_file() {
        local filename="$1" dst="$2" label="$3"
        for dir in "${PATCH_DIRS[@]}"; do
            if [[ -f "$dir/$filename" ]]; then
                cp "$dir/$filename" "$dst"
                echo -e "${GRN}[PATCH]${RST} ✅ $label  ← $(basename $dir)/$filename"
                return 0
            fi
        done
        echo -e "${YLW}[PATCH]${RST} ⚠️  $label — not found in patch dirs, keeping existing"
    }

    echo -e "${CYN}[PATCH]${RST} Deploying files..."
    deploy_file "flask_unified_complete.py"  "$FLASK_DIR/flask_unified_complete.py" "flask_unified_complete.py"
    deploy_file "EnergySystemContext.tsx"    "$CTX_DIR/EnergySystemContext.tsx"      "EnergySystemContext.tsx"
    deploy_file "UnifiedSSROutletCard.tsx"   "$COMP_DIR/UnifiedSSROutletCard.tsx"    "UnifiedSSROutletCard.tsx"
    deploy_file "KioskLCD.tsx"              "$COMP_DIR/KioskLCD.tsx"               "KioskLCD.tsx"
    echo ""

""

    # ── Verify correct files are deployed ─────────────────────
    echo -e "${CYN}[VERIFY]${RST} Checking fixes..."
    ok=true
    chk_py()  { grep -q "$2" "$1" 2>/dev/null && echo -e "${GRN}[VERIFY]${RST} ✅ $3" || { echo -e "${RED}[VERIFY]${RST} ❌ MISSING: $3 — wrong file!"; ok=false; }; }
    chk_tsx() { grep -q "$2" "$1" 2>/dev/null && echo -e "${GRN}[VERIFY]${RST} ✅ $3" || { echo -e "${RED}[VERIFY]${RST} ❌ MISSING: $3 — wrong file!"; ok=false; }; }

    chk_py  "$FLASK_DIR/flask_unified_complete.py"  "_arduino_reconnect"   "Flask: arduino reconnect"
    chk_py  "$FLASK_DIR/flask_unified_complete.py"  "recovery_set_at"      "Flask: recovery hang fix"
    chk_py  "$FLASK_DIR/flask_unified_complete.py"  "FIX-SOLAR-DATETIME"   "Flask: solar datetime fix"
    chk_py  "$FLASK_DIR/flask_unified_complete.py"  "FIX-ASSIST"           "Flask: K1+K2 assist mode"
    chk_tsx "$CTX_DIR/EnergySystemContext.tsx"       "FIX-ARDUINO-HANG"     "Context: hang fix"
    chk_tsx "$CTX_DIR/EnergySystemContext.tsx"       "FIX-STALE-CLOSURE"    "Context: K1/K2 stale closure"
    chk_tsx "$COMP_DIR/UnifiedSSROutletCard.tsx"     "K4 Contactor"         "UnifiedSSR: K4 labels"
    chk_tsx "$COMP_DIR/KioskLCD.tsx"                "K4 Contactor"         "KioskLCD: K4 labels"
    chk_tsx "$COMP_DIR/KioskLCD.tsx"                "graphSlide"           "KioskLCD: graph version"

    if [[ "$ok" == "false" ]]; then
        echo ""
        echo -e "${RED}[VERIFY]${RST} ❌ Wrong files deployed — build aborted."
        echo -e "         Put the 4 patch files in: ${YLW}~/heliogrid-patches/${RST}"
        echo -e "         Files needed:"
        echo -e "           flask_unified_complete.py"
        echo -e "           EnergySystemContext.tsx"
        echo -e "           UnifiedSSROutletCard.tsx"
        echo -e "           KioskLCD.tsx"
        exit 1
    fi
    echo ""

    echo -e "${YLW}[BUILD]${RST} Running npm run build..."
    cd "$NPM_DIR" || { echo -e "${RED}[ERROR]${RST} Not found: $NPM_DIR"; exit 1; }
    npm run build || { echo -e "${RED}[BUILD]${RST} ❌ Failed"; exit 1; }
    echo -e "${GRN}[BUILD]${RST} ✅ Complete"
fi

# ── AUTO-STOP before starting ───────────────────────────────
echo -e "${YLW}[PRESTOP]${RST} Stopping any running services..."
if [[ -f "$PID_FILE" ]]; then
    while IFS= read -r pid; do
        kill -0 "$pid" 2>/dev/null && kill "$pid" 2>/dev/null
    done < "$PID_FILE"
    rm -f "$PID_FILE"
fi
for PORT in 5000 5001 3000; do
    PIDS=$(lsof -ti tcp:"$PORT" 2>/dev/null)
    [[ -n "$PIDS" ]] && kill $PIDS 2>/dev/null
done
[[ -f "$NGINX_CONF" ]] && nginx -s stop -c "$NGINX_CONF" 2>/dev/null
pkill -f ngrok 2>/dev/null
pkill -f vite 2>/dev/null
pkill -f "flask_unified_complete" 2>/dev/null
pkill -f "email_service_app" 2>/dev/null
sleep 1
echo -e "${GRN}[PRESTOP]${RST} Done."

for PORT in 5000 5001; do
    lsof -ti tcp:"$PORT" &>/dev/null && \
        echo -e "${YLW}[WARN]${RST} Port $PORT still in use"
done

echo ""
echo -e "${CYN}╔══════════════════════════════════════════╗${RST}"
echo -e "${CYN}║       HelioGrid — Starting Services      ║${RST}"
echo -e "${CYN}╚══════════════════════════════════════════╝${RST}"
echo ""

# ── 1. Email (5001) ──────────────────────────────────────────
echo -e "${BLU}[EMAIL]${RST} Starting email service..."
cd "$EMAIL_DIR" || { echo -e "${RED}[ERROR]${RST} Not found: $EMAIL_DIR"; exit 1; }
[[ -f "$EMAIL_DIR/venv/bin/activate" ]] && source "$EMAIL_DIR/venv/bin/activate"
nohup python3 email_service_app.py > "$EMAIL_LOG" 2>&1 &
EMAIL_PID=$!
echo -e "${BLU}[EMAIL]${RST} PID $EMAIL_PID"
for i in {1..10}; do
    sleep 0.5
    curl -s http://localhost:5001/api/health &>/dev/null && \
        echo -e "${GRN}[EMAIL]${RST} ✅ Ready" && break
    [[ $i -eq 10 ]] && echo -e "${YLW}[EMAIL]${RST} ⚠️  Not ready yet"
done

# ── 2. Flask (5000) ──────────────────────────────────────────
echo ""
echo -e "${GRN}[FLASK]${RST} Starting Flask..."
cd "$FLASK_DIR" || { echo -e "${RED}[ERROR]${RST} Not found: $FLASK_DIR"; exit 1; }
[[ -f "$FLASK_DIR/venv/bin/activate" ]] && source "$FLASK_DIR/venv/bin/activate"
nohup python3 flask_unified_complete.py > "$FLASK_LOG" 2>&1 &
FLASK_PID=$!
echo -e "${GRN}[FLASK]${RST} PID $FLASK_PID"
for i in {1..20}; do
    sleep 0.5
    curl -s http://localhost:5000/api/system/health &>/dev/null && \
        echo -e "${GRN}[FLASK]${RST} ✅ Ready" && break
    [[ $i -eq 20 ]] && echo -e "${YLW}[FLASK]${RST} ⚠️  Not ready yet"
done

# ── 3. Frontend (3000) ───────────────────────────────────────
# Strategy A: Nginx (installed) + dist/ exists → production, best performance
# Strategy B: npm run dev fallback → Vite built-in proxy handles /api/
echo ""
USE_NGINX=false
command -v nginx &>/dev/null && USE_NGINX=true

if $USE_NGINX && [[ -d "$NPM_DIR/dist" ]]; then
    echo -e "${YLW}[NGINX]${RST} Starting Nginx on port 3000 (proxy + static serve)..."

    NGINX_PID_FILE="$LOG_DIR/nginx.pid"
    mkdir -p "$LOG_DIR/nginx_tmp/"{client_body,proxy,fastcgi,uwsgi,scgi}

    cat > "$NGINX_CONF" << NGINXEOF
pid         $NGINX_PID_FILE;
error_log   $LOG_DIR/nginx_error.log warn;
worker_processes 1;
events { worker_connections 256; }
http {
    include      /etc/nginx/mime.types;
    default_type application/octet-stream;
    access_log   $LOG_DIR/nginx_access.log;

    client_body_temp_path $LOG_DIR/nginx_tmp/client_body;
    proxy_temp_path       $LOG_DIR/nginx_tmp/proxy;
    fastcgi_temp_path     $LOG_DIR/nginx_tmp/fastcgi;
    uwsgi_temp_path       $LOG_DIR/nginx_tmp/uwsgi;
    scgi_temp_path        $LOG_DIR/nginx_tmp/scgi;

    sendfile on;
    keepalive_timeout 65;
    gzip on;

    server {
        listen 3000;
        root $NPM_DIR/dist;
        index index.html;

        location /api/ {
            proxy_pass       http://127.0.0.1:5000;
            proxy_set_header Host \$host;
            proxy_set_header X-Real-IP \$remote_addr;
            proxy_read_timeout 30;
        }
        location /auth/ {
            proxy_pass       http://127.0.0.1:5000;
            proxy_set_header Host \$host;
            proxy_set_header X-Real-IP \$remote_addr;
        }
        location /email-api/ {
            rewrite ^/email-api/(.*) /\$1 break;
            proxy_pass       http://127.0.0.1:5001;
            proxy_set_header Host \$host;
        }
        location / {
            try_files \$uri \$uri/ /index.html;
        }
        location ~* \.(js|css|png|jpg|ico|svg|woff2?)$ {
            expires 7d;
            add_header Cache-Control "public, immutable";
        }
    }
}
NGINXEOF

    nginx -t -c "$NGINX_CONF" 2>/dev/null
    if [[ $? -eq 0 ]]; then
        nginx -c "$NGINX_CONF"
        NPM_PID=$(cat "$NGINX_PID_FILE" 2>/dev/null || echo "?")
        echo -e "${GRN}[NGINX]${RST} ✅ Port 3000 — /api/* → Flask :5000"
    else
        echo -e "${YLW}[NGINX]${RST} ⚠️  Config failed — falling back to npm run dev"
        USE_NGINX=false
    fi
fi

if ! $USE_NGINX; then
    echo -e "${YLW}[NPM]${RST}   Starting npm run dev (Vite proxy active)..."
    cd "$NPM_DIR" || exit 1
    pkill -f vite 2>/dev/null; sleep 1
    nohup npm run dev > "$NPM_LOG" 2>&1 &
    NPM_PID=$!
    echo -e "${YLW}[NPM]${RST}   PID $NPM_PID"
    for i in {1..30}; do
        sleep 0.5
        curl -s http://localhost:3000 &>/dev/null && \
            echo -e "${GRN}[NPM]${RST}   ✅ Ready on port 3000" && break
        [[ $i -eq 30 ]] && echo -e "${YLW}[NPM]${RST}   ⚠️  Still starting..."
    done
fi

# ── 4. ngrok ─────────────────────────────────────────────────
echo ""
echo -e "${CYN}[NGROK]${RST} Starting ngrok tunnel..."
pkill -f ngrok 2>/dev/null; sleep 1
NGROK_LOG="$LOG_DIR/ngrok.log"
NGROK_DOMAIN="upfront-importer-crudeness.ngrok-free.dev"
nohup ngrok http --url="$NGROK_DOMAIN" 3000 > "$NGROK_LOG" 2>&1 &
NGROK_PID=$!
for i in {1..20}; do
    sleep 0.5
    curl -s http://localhost:4040/api/tunnels &>/dev/null && \
        echo -e "${GRN}[NGROK]${RST} ✅ https://$NGROK_DOMAIN" && break
    [[ $i -eq 20 ]] && echo -e "${YLW}[NGROK]${RST} ⚠️  Not ready yet"
done

echo -e "$EMAIL_PID\n$FLASK_PID\n$NPM_PID\n$NGROK_PID" > "$PID_FILE"

# ── 5. Kiosk Launch (lxterminal + Chromium) ──────────────────
if [[ "$1" != "rebuild" ]]; then
    echo ""
    echo -e "${CYN}[KIOSK]${RST} Launching terminals and Chromium..."

    export DISPLAY=:0
    export XAUTHORITY=/home/r-pi/.Xauthority

    # Kill existing Chromium
    pkill -f chromium 2>/dev/null
    sleep 1

    # Open Flask log terminal
    lxterminal --title="HelioGrid — Flask" \
        -e "bash -c 'tail -f $FLASK_LOG; bash'" &

    # Open ngrok log terminal
    lxterminal --title="HelioGrid — ngrok" \
        -e "bash -c 'tail -f $LOG_DIR/ngrok.log; bash'" &

    sleep 3

    # Wait for frontend ready
    echo -e "${CYN}[KIOSK]${RST} Waiting for frontend..."
    for i in {1..30}; do
        curl -s http://localhost:3000 &>/dev/null && break
        sleep 0.5
    done

    # Launch Chromium fullscreen kiosk → KioskLCD
    chromium \
        --start-fullscreen \
        --kiosk \
        --noerrdialogs \
        --disable-infobars \
        --no-first-run \
        --disable-session-crashed-bubble \
        'http://localhost:3000/?kiosk=true' \
        > /dev/null 2>&1 &
    CHROMIUM_PID=$!
    echo -e "${GRN}[KIOSK]${RST} ✅ Chromium → localhost:3000/?kiosk=true (PID $CHROMIUM_PID)"
    echo "$CHROMIUM_PID" >> "$PID_FILE"
fi

# ── Summary ──────────────────────────────────────────────────
echo ""
echo -e "${CYN}╔══════════════════════════════════════════╗${RST}"
echo -e "${CYN}║           HelioGrid Running              ║${RST}"
echo -e "${CYN}╠══════════════════════════════════════════╣${RST}"
echo -e "${CYN}║${RST} ${BLU}Email${RST}  → http://localhost:5001       PID $EMAIL_PID"
echo -e "${CYN}║${RST} ${GRN}Flask${RST}  → http://localhost:5000       PID $FLASK_PID"
if $USE_NGINX; then
echo -e "${CYN}║${RST} ${YLW}Nginx${RST}  → http://localhost:3000       PID $NPM_PID"
else
echo -e "${CYN}║${RST} ${YLW}Vite ${RST}  → http://localhost:3000       PID $NPM_PID"
fi
echo -e "${CYN}║${RST} ${CYN}ngrok${RST}  → https://$NGROK_DOMAIN"
echo -e "${CYN}╠══════════════════════════════════════════╣${RST}"
echo -e "${CYN}║${RST} Stop:    bash start_heliogrid.sh stop"
echo -e "${CYN}║${RST} Restart: bash start_heliogrid.sh restart"
echo -e "${CYN}║${RST} Rebuild: bash start_heliogrid.sh rebuild"
echo -e "${CYN}╚══════════════════════════════════════════╝${RST}"
echo ""

# ── Live log tail ─────────────────────────────────────────────
echo -e "${CYN}[LOGS]${RST} Tailing logs (Ctrl+C detaches — services keep running):"
echo ""
tail -f "$EMAIL_LOG" | sed "s/^/${BLU}[EMAIL]${RST} /" &
TAIL_EMAIL=$!
tail -f "$FLASK_LOG"  | sed "s/^/${GRN}[FLASK]${RST} /" &
TAIL_FLASK=$!
if $USE_NGINX; then
    touch "$LOG_DIR/nginx_access.log"
    tail -f "$LOG_DIR/nginx_access.log" | sed "s/^/${YLW}[NGINX]${RST} /" &
else
    tail -f "$NPM_LOG" | sed "s/^/${YLW}[NPM]  ${RST} /" &
fi
TAIL_NPM=$!
tail -f "$NGROK_LOG" | sed "s/^/${CYN}[NGROK]${RST} /" &
TAIL_NGROK=$!

trap "kill $TAIL_EMAIL $TAIL_FLASK $TAIL_NPM $TAIL_NGROK 2>/dev/null; echo '';
echo -e \"${CYN}[INFO]${RST} Detached. Services still running.\";
echo -e \"      Stop: bash start_heliogrid.sh stop\"; exit 0" INT

wait

#!/bin/bash
# PaperClip Desktop Launcher
# Clears NODE_OPTIONS that Electron explicitly rejects with:
#   "--use-system-ca is not allowed in NODE_OPTIONS"

pkill -f "PaperClip" 2>/dev/null
sleep 1

# Clear the problematic env var and launch the binary directly
NODE_OPTIONS="" nohup /Applications/PaperClip.app/Contents/MacOS/PaperClip > /tmp/paperclip.log 2>&1 &

echo "PaperClip Desktop launched (PID $!)"
echo "Server logs: ~/.paperclip/instances/default/logs/server.log"
echo "Expected URL: http://127.0.0.1:3100 or :3101"
echo ""
echo "Waiting for server to come up..."

for i in $(seq 1 15); do
    sleep 2
    for port in 3100 3101; do
        if curl -sf http://127.0.0.1:$port/api/health > /dev/null 2>&1; then
            echo "✓ PaperClip is running at http://127.0.0.1:$port"
            exit 0
        fi
    done
    echo "  ... waiting ($((i*2))s)"
done

echo "⚠ Server not responding after 30s. Check /tmp/paperclip.log for errors."

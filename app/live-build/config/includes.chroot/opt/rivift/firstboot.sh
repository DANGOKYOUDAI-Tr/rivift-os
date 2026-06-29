#!/bin/bash
# Rivift OS first-boot setup
set -e
if [ -f /opt/rivift/.firstboot-done ]; then
    exit 0
fi
# Backlight udev rules
cat > /etc/udev/rules.d/90-rivift-backlight.rules << 'EOF'
SUBSYSTEM=="backlight", ACTION=="add", RUN+="/bin/chgrp video /sys/class/backlight/%k/brightness", RUN+="/bin/chmod g+w /sys/class/backlight/%k/brightness"
EOF
udevadm control --reload-rules || true

touch /opt/rivift/.firstboot-done
exit 0

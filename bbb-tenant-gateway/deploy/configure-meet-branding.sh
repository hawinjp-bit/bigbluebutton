#!/usr/bin/env bash

set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

brand_name="${BRAND_NAME:-meet}"
brand_help_url="${BRAND_HELP_URL:-https://meet.ooak.jp/portal}"
html5_override="/etc/bigbluebutton/bbb-html5.yml"
web_override="/etc/bigbluebutton/bbb-web.properties"
html5_root="/usr/share/bigbluebutton/html5-client"

command -v yq >/dev/null
command -v python3 >/dev/null

for required_path in \
  "${html5_override}" \
  "${web_override}" \
  "${html5_root}/index.html" \
  "${html5_root}/locales"; do
  if [[ ! -e "${required_path}" ]]; then
    echo "Required BigBlueButton path is missing: ${required_path}" >&2
    exit 1
  fi
done

export BRAND_NAME="${brand_name}"
export BRAND_HELP_URL="${brand_help_url}"

# Keep supported HTML5 settings in the package-independent override file.
yq eval -i '.public.app.clientTitle = strenv(BRAND_NAME)' "${html5_override}"
yq eval -i '.public.app.displayBbbServerVersion = false' "${html5_override}"
yq eval -i '.public.app.copyright = "© " + strenv(BRAND_NAME)' "${html5_override}"
yq eval -i '.public.app.helpLink = strenv(BRAND_HELP_URL)' "${html5_override}"
yq eval -i '.public.app.bbbTabletApp.enabled = false' "${html5_override}"

WEB_OVERRIDE="${web_override}" \
HTML5_ROOT="${html5_root}" \
python3 <<'PY'
import json
import os
from pathlib import Path
import re

brand_name = os.environ["BRAND_NAME"]
brand_help_url = os.environ["BRAND_HELP_URL"]
web_override = Path(os.environ["WEB_OVERRIDE"])
html5_root = Path(os.environ["HTML5_ROOT"])


def set_property(text: str, name: str, value: str) -> str:
    replacement = f"{name}={value}"
    pattern = re.compile(rf"^{re.escape(name)}=.*$", re.MULTILINE)
    if pattern.search(text):
        return pattern.sub(replacement, text)
    if text and not text.endswith("\n"):
        text += "\n"
    return text + replacement + "\n"


properties = web_override.read_text(encoding="utf-8")
properties = set_property(
    properties,
    "beans.presentationService.defaultUploadedPresentation",
    "null",
)
properties = set_property(
    properties,
    "defaultWelcomeMessage",
    (
        "Welcome to <b>%%CONFNAME%%</b>!<br><br>"
        f'For help, visit <a href="{brand_help_url}" target="_blank">'
        f"<u>{brand_name}</u></a>."
    ),
)
properties = set_property(properties, "defaultWelcomeMessageFooter", "")
web_override.write_text(properties, encoding="utf-8")

index_path = html5_root / "index.html"
index = index_path.read_text(encoding="utf-8")
index, count = re.subn(
    r"<title>[^<]*</title>",
    f"<title>{brand_name}</title>",
    index,
    count=1,
)
if count != 1:
    raise RuntimeError(f"Unable to update the HTML title in {index_path}")
index_path.write_text(index, encoding="utf-8")

locale_dir = html5_root / "locales"
locale_files = sorted(locale_dir.glob("*.json"))
if not locale_files:
    raise RuntimeError(f"No locale files found in {locale_dir}")

for locale_path in locale_files:
    locale_text = locale_path.read_text(encoding="utf-8")
    branded_text = locale_text.replace("BigBlueButton", brand_name)
    json.loads(branded_text)
    if branded_text != locale_text:
        locale_path.write_text(branded_text, encoding="utf-8")
PY

chown root:root "${html5_override}"
chown root:bigbluebutton "${web_override}"
chmod 0644 "${html5_override}"
chmod 0640 "${web_override}"

echo "Applied ${brand_name} branding and disabled the default presentation."
echo "Restart bbb-apps-akka.service and bbb-web.service to activate the changes."

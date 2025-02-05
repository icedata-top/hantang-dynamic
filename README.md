## Setup Instructions

1. Download the executable for your platform from the latest GitHub Actions artifacts:

   - `bilibili-dynamic-subscribe-linux` for Linux
   - `bilibili-dynamic-subscribe-win.exe` for Windows
   - `bilibili-dynamic-subscribe-macos` for macOS

2. Create a `.env` file in the same directory as the executable with the following settings:

   ```env
   # Required settings
   SESSDATA = "your_sessdata"         # Your Bilibili session data
   UID = "your_uid"                   # Your Bilibili user ID

   # Optional settings
   FETCH_INTERVAL = 900000            # Fetch interval in ms (default: 15 minutes)
   API_WAIT_TIME = 2000              # Wait time between API calls (default: 2000ms)
   MAX_HISTORY_DAYS = 7              # Maximum days of history to fetch (default: 7)
   ENABLE_TAG_FETCH = "true"         # Whether to fetch video tags (default: false)
   ```

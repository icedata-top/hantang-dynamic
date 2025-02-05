# Bilibili Tracker

Bilibili Tracker is a TypeScript application that periodically fetches the latest videos from users you follow on Bilibili. The application utilizes Bilibili's APIs to retrieve video data and stores it in a CSV format for easy access and analysis.

## Features

- Fetches the latest videos from followed users every 15 minutes.
- Utilizes Bilibili's dynamic APIs to retrieve new and historical video data.
- Stores video information in a CSV file with specified fields.
- Configurable authentication settings for Bilibili.

## Project Structure

```
bilibili-tracker
├── src
│   ├── app.ts          # Main entry point of the application
│   ├── api.ts          # Functions to interact with Bilibili APIs
│   ├── csv.ts          # Functionality to store data in CSV format
│   └── utils
│       └── scheduler.ts # Scheduling logic for fetching videos
├── config
│   └── bilibili.toml   # Configuration for Bilibili authentication
├── .gitignore          # Files and directories to ignore by Git
├── package.json        # npm configuration file
├── tsconfig.json       # TypeScript configuration file
└── README.md           # Documentation for the project
```

## Setup Instructions

1. Clone the repository:
   ```
   git clone https://github.com/yourusername/bilibili-tracker.git
   cd bilibili-tracker
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Configure your Bilibili authentication settings in `config/bilibili.toml`:
   ```toml
   SESSDATA = "your_sessdata"
   UID = "your_uid"
   ```

4. Run the application:
   ```
   npm start
   ```

## Usage

The application will automatically fetch the latest videos from your followed users every 15 minutes. The fetched data will be stored in a CSV file for your review.

## License

This project is licensed under the MIT License.
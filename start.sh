#!/bin/bash
# Check if .env exists in the same directory
if [ ! -f "$(dirname "$0")/.env" ]; then
    echo "Error: .env file not found!"
    echo "Please create a .env file with your configuration"
    read -p "Press any key to continue..."
    exit 1
fi

# Run the executable
"$(dirname "$0")/bilibili-dynamic-subscribe-linux"
read -p "Press any key to continue..."
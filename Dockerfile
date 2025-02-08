FROM alpine:3.21

WORKDIR /app

# Copy Linux executable 
COPY dist/executables/bilibili-dynamic-subscribe-linux /app/bilibili-dynamic-subscribe

# Add execution permissions
RUN chmod +x /app/bilibili-dynamic-subscribe

# Default environment variables
ENV FETCH_INTERVAL=900000 \
    API_WAIT_TIME=2000 \
    MAX_HISTORY_DAYS=7 \
    ENABLE_TAG_FETCH=true

# Run the app
CMD ["/app/bilibili-dynamic-subscribe"]
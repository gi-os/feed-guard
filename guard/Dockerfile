FROM python:3.12-alpine
RUN pip install --no-cache-dir requests pyyaml
WORKDIR /app
COPY guard.py .
CMD ["python", "-u", "guard.py"]

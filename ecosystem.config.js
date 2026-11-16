module.exports = {
  apps: [
    {
      name: "pkc-gateway",
      script: "gateway.js",
      cwd: "/opt/pkc/node-gateway",
      autorestart: true,
      max_memory_restart: "300M",
      env: {
        NODE_ENV: "production",
      },
      out_file: "/var/log/pkc-gateway/out.log",
      error_file: "/var/log/pkc-gateway/error.log",
      merge_logs: true,
      time: true,
    },
  ],
};

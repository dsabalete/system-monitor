# AGENTS.md

This file contains guidelines and commands for agentic coding agents working in this repository.

## Build/Lint/Test Commands

### Available Scripts
- `npm start` - Start the production server (runs index.js)
- `npm test` - Run the single test file (test/format.test.js)
- `npm run stats` - Print current system statistics
- `npm run collect:hdd` - Run HDD collection script
- `npm run collect:sd` - Run SD card collection script
- `npm run load:test` - Run load testing script

### Running Tests
This project uses a simple test framework with Node.js built-in `assert/strict`. To run tests:
```bash
npm test
```

To run a single test file manually:
```bash
node test/format.test.js
```

### No Linting/Formatting Tools
This project does not use ESLint, Prettier, or TypeScript. Code should be manually formatted according to the style guidelines below.

## Code Style Guidelines

### General
- Use CommonJS modules (`require`/`module.exports`)
- Use 2-space indentation (consistent with existing code)
- Use single quotes for strings unless embedding single quotes
- No trailing semicolons (follow existing pattern)
- Keep lines under 120 characters when possible

### Imports and Dependencies
- Group imports at the top of files: Node.js built-ins first, then external packages, then local modules
- Use destructuring for require statements when appropriate:
  ```javascript
  const { PORT, NODE_ENV } = require('./config');
  ```
- All external dependencies are listed in package.json

### Naming Conventions
- **Variables and functions**: camelCase
- **Constants**: UPPER_SNAKE_CASE (for configuration values)
- **Files**: kebab-case for scripts, camelCase for source files
- **Directories**: kebab-case
- **Functions that return constructors**: createX pattern (e.g., `createApp`, `createStatsCollector`)

### Error Handling
- Use try/catch blocks for async operations
- Return null or empty objects for non-critical failures
- Log errors with `console.error()` in production
- Include error details in API responses only in non-production environments:
  ```javascript
  const details = NODE_ENV === "production" ? undefined : error?.message;
  res.status(500).json({ error: "Error message", details });
  ```

### Function Patterns
- Use factory functions for creating objects with dependencies
- Async functions should handle errors gracefully
- Use Promise.race() for timeout implementations
- Helper functions should be pure and stateless

### API Response Format
- All API endpoints return JSON
- Use consistent error response format: `{ error: string, details?: string }`
- Use 200 for success, 500 for server errors, 503 for unavailable features
- Include proper Content-Type headers

### Configuration
- All configuration is in `src/config.js`
- Use environment variables with fallbacks
- Use the `numberFromEnv()` helper for numeric config values
- Boolean config values use string comparison: `String(process.env.VAR || "").toLowerCase() === "true"`

### Database Patterns
- SQLite is optional (controlled by DISABLE_SQLITE)
- Use better-sqlite3 for database operations
- All database operations should handle DISABLE_SQLITE flag
- Use parameterized queries to prevent SQL injection

### File Structure
```
src/
├── app.js          # Express app creation and routes
├── config.js       # Configuration management
├── stats/          # System statistics collection
│   ├── index.js    # Main stats collector
│   └── format.js   # Formatting utilities
├── db/             # Database operations
└── metrics/        # Prometheus metrics
public/             # Static frontend files
scripts/            # Utility scripts
test/              # Test files
```

### Frontend Code
- Use vanilla JavaScript (no frameworks)
- Use async/await for API calls
- Update DOM elements by ID
- Use consistent formatting functions
- Handle fetch errors gracefully

### Testing
- Use Node.js built-in `assert/strict`
- Write simple assertion-based tests
- Test formatting functions and utilities
- Include console.log for test completion confirmation

### Security
- Never log sensitive data (passwords, tokens)
- Use proper timeout values for external requests
- Sanitize user input in API endpoints
- Use basic authentication headers for external services

### Performance
- Use caching for expensive operations (e.g., transmission session IDs)
- Implement proper timeouts for all external calls
- Use Promise.all() for parallel async operations
- Avoid blocking operations in API routes

### Comments and Documentation
- Use JSDoc-style comments for functions
- Comment complex logic or workarounds
- Include parameter types and return values
- No inline comments for obvious code

## Development Notes

### Raspberry Pi Specifics
- This application is designed for Raspberry Pi
- Uses Pi-specific commands (`vcgencmd`)
- Handles thermal zones and GPU temperature monitoring
- Monitors throttling status via vcgencmd

### External Dependencies
- `systeminformation` for cross-platform system stats
- `better-sqlite3` for optional database storage
- `express` for web server
- `prom-client` for Prometheus metrics

### Debugging
- Use `DEBUG_STATS=true` environment variable for detailed logging
- Debug logs go to `console.error()` with `[stats]` prefix
- Include timestamps and context in debug messages
# Contributing to Trader Vaults

Thank you for your interest in contributing to Trader Vaults! We welcome contributions from the community and are excited to have you help us build the best trading vault platform on Solana.

## 📋 Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Submitting Changes](#submitting-changes)
- [Coding Standards](#coding-standards)
- [Testing Guidelines](#testing-guidelines)
- [Documentation](#documentation)

## 🤝 Code of Conduct

By participating in this project, you agree to maintain a respectful, inclusive environment. Please be respectful of different viewpoints and experiences.

## 🚀 Getting Started

### Prerequisites

- Node.js 20+ 
- PostgreSQL 14+
- Git
- Solana wallet (for testing)

### First Steps

1. **Fork the repository**
   ```bash
   # Click "Fork" on https://github.com/omarpatel/trader-vaults
   ```

2. **Clone your fork**
   ```bash
   git clone https://github.com/YOUR_USERNAME/trader-vaults.git
   cd trader-vaults
   ```

3. **Add upstream remote**
   ```bash
   git remote add upstream https://github.com/omarpatel/trader-vaults.git
   ```

## 🛠️ Development Setup

### Installation

```bash
# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
# Edit .env with your local configuration

# Set up database
npx prisma generate
npx prisma migrate dev

# Start development servers
npm run dev
```

### Development Commands

```bash
# Start all services
npm run dev

# Start API server only
npm run dev:api

# Start web app only  
npm run dev:web

# Run tests
npm test

# Run linter
npm run lint

# Format code
npm run format

# Build for production
npm run build
```

## 📝 Submitting Changes

### Workflow

1. **Create a branch**
   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/your-bug-fix
   ```

2. **Make your changes**
   - Follow our coding standards
   - Add tests for new functionality
   - Update documentation
   - Ensure all tests pass

3. **Commit your changes**
   ```bash
   git add .
   git commit -m "feat: add your feature description"
   # Use conventional commits: feat:, fix:, docs:, style:, refactor:, test:, chore:
   ```

4. **Push to your fork**
   ```bash
   git push origin feature/your-feature-name
   ```

5. **Create a Pull Request**
   - Go to https://github.com/omarpatel/trader-vaults/pulls
   - Click "New Pull Request"
   - Fill out the PR template
   - Link related issues

### Pull Request Guidelines

- **Description**: Clearly describe what you changed and why
- **Testing**: Explain how you tested your changes
- **Screenshots**: Include screenshots for UI changes
- **Breaking Changes**: Highlight any breaking changes
- **Documentation**: Update relevant documentation

## 📐 Coding Standards

### TypeScript

- Use strict TypeScript mode
- Avoid `any` types
- Use interfaces for object shapes
- Use type aliases for unions/intersections
- Add JSDoc comments for complex functions

### React

- Use functional components with hooks
- Follow React best practices
- Use TypeScript props interfaces
- Handle loading and error states
- Keep components focused and reusable

### API Routes

- Use proper HTTP methods
- Return consistent response formats
- Handle errors appropriately
- Add input validation
- Include proper error messages

### Database

- Use Prisma ORM
- Write efficient queries
- Use transactions when needed
- Add indexes for performance
- Handle connection errors

### Code Style

- Use 2 spaces for indentation
- Use single quotes for strings
- Add trailing commas
- Use semicolons
- Keep functions focused

## 🧪 Testing Guidelines

### Test Coverage

- Aim for 80%+ code coverage
- Test critical paths thoroughly
- Include edge cases
- Mock external dependencies

### Test Types

```bash
# Unit tests
npm run test:unit

# Integration tests
npm run test:integration

# E2E tests
npm run test:e2e

# All tests with coverage
npm run test:coverage
```

### Testing Best Practices

- Write tests before implementing features (TDD)
- Test error conditions
- Use descriptive test names
- Keep tests independent
- Mock external services

## 📚 Documentation

### Code Comments

- Add JSDoc comments for functions
- Explain complex logic
- Document configuration options
- Keep comments up to date

### API Documentation

- Document all endpoints
- Include request/response examples
- Document error responses
- Keep API docs current

### README Updates

- Update README for new features
- Add usage examples
- Document breaking changes
- Update dependencies

## 🐛 Bug Reports

### Before Reporting

- Search existing issues
- Check if it's a known limitation
- Verify it's not a configuration issue

### Bug Report Template

```markdown
**Description**
A clear description of the bug.

**Reproduction Steps**
1. Go to '...'
2. Click on '...'
3. Scroll down to '...'
4. See error

**Expected Behavior**
What should have happened.

**Actual Behavior**
What actually happened.

**Screenshots**
If applicable, add screenshots.

**Environment**
- OS: [e.g. Windows 11]
- Browser: [e.g. Chrome 120]
- Node.js version: [e.g. 20.10.0]
- Trader Vaults version: [e.g. 1.0.0]

**Additional Context**
Any other relevant information.
```

## 💡 Feature Requests

### Before Requesting

- Check if it's already planned
- Search existing feature requests
- Consider if it fits the project scope

### Feature Request Template

```markdown
**Is your feature request related to a problem?**
A clear description of the problem.

**Describe the solution you'd like**
A clear description of what you want to happen.

**Describe alternatives you've considered**
Any alternative solutions or features you've considered.

**Additional context**
Any other context, mockups, or examples.
```

## 🎯 Project Goals

- **Performance**: Fast and responsive user experience
- **Security**: Secure trading and user data
- **Reliability**: High uptime and error handling
- **Usability**: Intuitive and professional interface
- **Scalability**: Handle increasing user base

## 📞 Getting Help

- **Documentation**: Check our docs first
- **Issues**: Search or create an issue
- **Discussions**: Ask questions in Discussions
- **Discord**: Join our community (coming soon)

## 🙏 Recognition

Contributors are recognized in our CONTRIBUTORS.md file and mentioned in release notes.

## 📄 License

By contributing, you agree that your contributions will be licensed under the MIT License.

---

Thank you for contributing to Trader Vaults! Your contributions help make our platform better for everyone.
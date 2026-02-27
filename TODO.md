# TODO - nakom-admin

## High Priority

### Create Localstack Integration Tests
- **Tag**: `create-localstack-here`
- **Goal**: Create comprehensive integration tests using Localstack that would have caught the frontend authentication token bug
- **Scope**:
  - Test full stack: CloudFront → API Gateway → Lambda
  - Test JWT authentication flow end-to-end
  - Test error handling and proper HTTP status codes
  - Verify frontend receives proper responses vs CloudFront error pages
- **Blog Post**: Document the process of setting up Localstack for complex AWS architectures
- **Status**: Pending frontend auth fix completion

## Medium Priority

### Frontend Architecture Cleanup
- **Issue**: Remove localStorage anti-pattern from analyticsService.ts
- **Solution**: Pass JWT tokens from useAuth() hook to service functions
- **Status**: In progress

### Infrastructure
- **CloudFront**: Consider separating error handling for API vs SPA routes
- **Monitoring**: Add more detailed logging for auth failures
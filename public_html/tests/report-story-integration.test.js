/**
 * Integration Test: Report Story functionality
 * 
 * This test verifies that the actual flag-quality.js code uses the correct
 * public endpoint (/api/analytics/quick-flag) instead of the admin-only
 * endpoint (/api/analytics/report-quality).
 * 
 * Bug: The per-pin "Report" button was calling /api/analytics/report-quality
 * which requires admin auth, causing 401 Unauthorized errors for public users.
 */

const fs = require('fs');
const path = require('path');

// Read the actual flag-quality.js file
const flagQualityPath = path.join(__dirname, '../flag-quality.js');
const flagQualityCode = fs.readFileSync(flagQualityPath, 'utf8');

// Test 1: Verify showReportDialog uses quick-flag endpoint
function testReportDialogEndpoint() {
  // Find the showReportDialog function
  const reportDialogMatch = flagQualityCode.match(/function showReportDialog[\s\S]*?^  }/m);
  
  if (!reportDialogMatch) {
    return { pass: false, message: "Could not find showReportDialog function" };
  }

  const functionCode = reportDialogMatch[0];

  // Check if it's using the WRONG endpoint (admin-only)
  if (functionCode.includes('/api/analytics/report-quality')) {
    return {
      pass: false,
      message: "BUG DETECTED: showReportDialog is using /api/analytics/report-quality (admin-only endpoint)"
    };
  }

  // Check if it's using the CORRECT endpoint (public)
  if (!functionCode.includes('/api/analytics/quick-flag')) {
    return {
      pass: false,
      message: "showReportDialog is not using /api/analytics/quick-flag endpoint"
    };
  }

  return { pass: true, message: "✓ showReportDialog uses correct public endpoint" };
}

// Test 2: Verify the payload structure for quick-flag
function testQuickFlagPayloadStructure() {
  // Find the fetch call in showReportDialog
  const fetchMatch = flagQualityCode.match(/showReportDialog[\s\S]*?fetch\(["']\/api\/analytics\/quick-flag["'][\s\S]*?body: JSON\.stringify\(\{[\s\S]*?\}\)/);
  
  if (!fetchMatch) {
    return {
      pass: false,
      message: "Could not find fetch call to /api/analytics/quick-flag in showReportDialog"
    };
  }

  const fetchCode = fetchMatch[0];

  // Verify required fields are present
  const requiredFields = ['input', 'report_type', 'session_id'];
  for (const field of requiredFields) {
    if (!fetchCode.includes(field)) {
      return {
        pass: false,
        message: `Missing required field "${field}" in quick-flag payload`
      };
    }
  }

  return { pass: true, message: "✓ Quick-flag payload has all required fields" };
}

// Test 3: Verify showQuickFlagDialog also uses quick-flag (should already be correct)
function testQuickFlagDialogEndpoint() {
  const quickFlagMatch = flagQualityCode.match(/function showQuickFlagDialog[\s\S]*?^  }/m);
  
  if (!quickFlagMatch) {
    return { pass: false, message: "Could not find showQuickFlagDialog function" };
  }

  const functionCode = quickFlagMatch[0];

  // This should already be using quick-flag
  if (!functionCode.includes('/api/analytics/quick-flag')) {
    return {
      pass: false,
      message: "showQuickFlagDialog is not using /api/analytics/quick-flag endpoint"
    };
  }

  return { pass: true, message: "✓ showQuickFlagDialog uses correct endpoint" };
}

// Test 4: Verify no direct calls to report-quality from public-facing code
function testNoAdminEndpointInPublicCode() {
  // Split the code into sections
  const lines = flagQualityCode.split('\n');
  
  // Find all fetch calls
  const fetchCalls = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('fetch(') && lines[i].includes('analytics')) {
      fetchCalls.push({ line: i + 1, code: lines[i].trim() });
    }
  }

  // Check each fetch call
  for (const call of fetchCalls) {
    if (call.code.includes('/api/analytics/report-quality')) {
      return {
        pass: false,
        message: `Line ${call.line}: Found call to admin-only endpoint /api/analytics/report-quality`
      };
    }
  }

  return { pass: true, message: "✓ No admin-only endpoints in public code" };
}

// Test 5: Verify the input field is passed as string (quick-flag expects string input)
function testInputFieldAsString() {
  // Find the showReportDialog function
  const reportDialogMatch = flagQualityCode.match(/function showReportDialog[\s\S]*?^  }/m);
  
  if (!reportDialogMatch) {
    return { pass: false, message: "Could not find showReportDialog function" };
  }

  const functionCode = reportDialogMatch[0];

  // Find the fetch call to quick-flag
  const fetchMatch = functionCode.match(/fetch\(["']\/api\/analytics\/quick-flag["'][\s\S]*?body: JSON\.stringify\(\{[\s\S]*?\}\)/);
  
  if (!fetchMatch) {
    return {
      pass: false,
      message: "Could not find fetch call to /api/analytics/quick-flag in showReportDialog"
    };
  }

  const fetchCode = fetchMatch[0];

  // Check if input is converted to string (String(), toString(), or template literal)
  const hasStringConversion = 
    fetchCode.includes('String(') || 
    fetchCode.includes('.toString()') || 
    fetchCode.includes('`${') ||
    fetchCode.includes('input: "') ||
    fetchCode.includes("input: '");

  if (!hasStringConversion) {
    return {
      pass: false,
      message: "Input field should be converted to string for quick-flag endpoint"
    };
  }

  return { pass: true, message: "✓ Input field properly converted to string" };
}

// Run all tests
function runTests() {
  console.log("\n=== Report Story Integration Tests ===\n");
  console.log("Testing actual flag-quality.js implementation...\n");
  
  const tests = [
    testReportDialogEndpoint,
    testQuickFlagPayloadStructure,
    testQuickFlagDialogEndpoint,
    testNoAdminEndpointInPublicCode,
    testInputFieldAsString,
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      const result = test();
      if (result.pass) {
        console.log(`✓ ${result.message}`);
        passed++;
      } else {
        console.log(`✗ ${result.message}`);
        failed++;
      }
    } catch (error) {
      console.log(`✗ Test threw error: ${error.message}`);
      failed++;
    }
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  
  if (failed > 0) {
    console.log("⚠️  BUG DETECTED: The per-pin Report button is using the wrong endpoint!");
    console.log("   Fix: Change /api/analytics/report-quality to /api/analytics/quick-flag\n");
  }
  
  return failed === 0;
}

// Export for browser and Node.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { runTests };
}

if (typeof window !== 'undefined') {
  window.ReportStoryIntegrationTests = { runTests };
}

// Auto-run if executed directly
if (typeof require !== 'undefined' && require.main === module) {
  const success = runTests();
  process.exit(success ? 0 : 1);
}

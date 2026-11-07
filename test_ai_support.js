require('dotenv').config({ path: __dirname + '/.env' });
const { handleSupportQuery } = require('./src/services/support_agent.service');
const { runMistralChat } = require('./src/services/cloudflare_ai.service');

async function testAiSystem() {
  console.log('====================================================');
  console.log('🤖 Shazu One AI Support System Verification Test');
  console.log('====================================================\n');

  // Test 1: Direct Cloudflare Workers AI LLM (Mistral 7B)
  console.log('👉 [Test 1] Testing Direct Cloudflare Mistral 7B Inference...');
  try {
    const mistralRes = await runMistralChat({
      messages: [
        { role: 'system', content: 'You are Shazu One AI assistant in Salem, Tamil Nadu. Reply in 1 brief sentence.' },
        { role: 'user', content: 'Hello, what services do you provide in Salem?' }
      ],
      maxTokens: 100
    });

    if (mistralRes.success) {
      console.log('✅ Cloudflare AI Direct Response:');
      console.log(`   "${(mistralRes.response || mistralRes.text || '').trim()}"\n`);
    } else {
      console.log('⚠️ Direct Cloudflare AI Note:', mistralRes.error, '\n');
    }
  } catch (err) {
    console.error('❌ Cloudflare AI Exception:', err.message, '\n');
  }

  // Test 2: Customer Pricing Inquiry
  console.log('👉 [Test 2] Testing Customer Inquiry: "What is the inspection visit fee in Salem?"');
  try {
    const customerTest = await handleSupportQuery({
      queryText: 'What is the inspection visit fee in Salem?',
      role: 'customer'
    });
    console.log('✅ Response:', customerTest.reply);
    console.log('   Escalate to Human Ops:', customerTest.escalateToOps);
    console.log('   Support Phone:', customerTest.opsContact?.phone, '\n');
  } catch (err) {
    console.error('❌ Customer Query Test Failed:', err.message, '\n');
  }

  // Test 3: Emergency / Human Escalation Test
  console.log('👉 [Test 3] Testing Urgent Escalation: "Emergency! Gas leaking from my AC!"');
  try {
    const emergencyTest = await handleSupportQuery({
      queryText: 'Emergency! Gas leaking from my AC!',
      role: 'customer'
    });
    console.log('✅ Escalation Detected:', emergencyTest.escalateToOps ? 'YES (Correct)' : 'NO');
    console.log('   Response Message:', emergencyTest.reply);
    console.log('   Direct WhatsApp Hotline:', emergencyTest.opsContact?.whatsappUrl, '\n');
  } catch (err) {
    console.error('❌ Emergency Test Failed:', err.message, '\n');
  }

  // Test 4: Live Render Endpoint Health Check
  console.log('👉 [Test 4] Checking Live Render Production Endpoint...');
  const remoteUrl = 'https://Shazu One-backend.onrender.com/api/v1/support/ai-chat';
  try {
    const fetch = globalThis.fetch;
    const res = await fetch(remoteUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'Hello', role: 'customer' })
    });
    console.log(`   HTTP Status Code: ${res.status} ${res.statusText}`);
    if (res.status === 200) {
      const data = await res.json();
      console.log('🎉 Live Render AI Backend is ONLINE and WORKING:');
      console.log('   Reply:', data.reply || data);
    } else if (res.status === 404) {
      console.log('ℹ️ Render is still deploying your latest commit (or waiting for git push). Check Render dashboard.');
    } else {
      console.log('ℹ️ Render response:', await res.text());
    }
  } catch (err) {
    console.log('⚠️ Could not connect to Render endpoint:', err.message);
  }

  console.log('\n====================================================');
  console.log('✨ AI System Test Completed');
  console.log('====================================================');
}

testAiSystem().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});

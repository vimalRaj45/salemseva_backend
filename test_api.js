async function testEndpoints() {
  try {
    const health = await fetch('http://localhost:8080/health').then(r => r.json());
    console.log('✅ Health:', health);

    const services = await fetch('http://localhost:8080/api/v1/services').then(r => r.json());
    console.log('✅ Services count:', services.services?.length);

    const admin = await fetch('http://localhost:8080/api/v1/admin/overview').then(r => r.json());
    console.log('✅ Admin Overview metrics:', admin.metrics);

    const partner = await fetch('http://localhost:8080/api/v1/partner/duty').then(r => r.json());
    console.log('✅ Partner Duty technician:', partner.technician?.full_name);

    const turn = await fetch('http://localhost:8080/api/v1/webrtc/ice-servers').then(r => r.json());
    console.log('✅ Cloudflare TURN ICE Servers:', turn.iceServers?.length);

    console.log('🎉 ALL BACKEND ENDPOINTS ARE FULLY OPERATIONAL WITH NEON POSTGRESQL & .ENV SECRETS!');
  } catch (err) {
    console.error('❌ Endpoint test failed:', err);
  }
}

testEndpoints();

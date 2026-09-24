process.stdout.write(JSON.stringify({generatedAt:new Date().toISOString(),summary:{catalogReadMode:process.env.B24_APP_CATALOG_SQL_READ??'off'}}));

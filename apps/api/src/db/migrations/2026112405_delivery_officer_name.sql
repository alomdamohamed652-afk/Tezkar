-- إضافة عمود اسم مسؤول التسليم لأذونات التسليم (إضافي، يقبل NULL، لا يغيّر بيانات قائمة)
ALTER TABLE delivery_permissions ADD COLUMN IF NOT EXISTS officer_name TEXT;

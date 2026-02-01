# Ограничение количества устройств для VPN-подписок

## Текущая реализация (для тестирования)

### Device Fingerprint
Генерируется хеш на основе:
- User-Agent
- Client Hints (model, platform)
- Первые 2 октета IP-адреса (частичный IP)

**Пример вывода в логах:**
```
[/connect/abc123] RAW UA: Mozilla/5.0 (Linux; Android 16; K) ...
[/connect/abc123] PLATFORM: Android
[/connect/abc123] MODEL: Unknown
[/connect/abc123] FINGERPRINT: a3f7e2c9b4d1f8e6
```

### ⚠️ Ограничения метода
**Device Fingerprint НЕ НАДЁЖЕН для строгих ограничений:**
- ❌ Одно устройство → разные браузеры → **разные fingerprint**
- ❌ Переустановка браузера → **новый fingerprint**
- ❌ Смена IP (мобильная сеть) → **новый fingerprint**
- ❌ VPN-клиенты обычно не открывают браузер → **не логируется**

### ✅ Рекомендуемые решения для production

## 1. Ограничение на уровне 3x-ui (лучший вариант)

### Вариант A: Ограничение одновременных подключений
В конфигурации клиента 3x-ui есть параметр `maxConnections`:

```typescript
// При создании/обновлении клиента в 3x-ui
await xui.updateClient({
  email: userEmail,
  settings: {
    maxConnections: 3, // Максимум 3 одновременных подключения
  },
});
```

**Плюсы:**
- ✅ Работает на уровне VPN-сервера (надёжно)
- ✅ Считает реальные активные подключения
- ✅ Не зависит от браузера/fingerprint

**Минусы:**
- ⚠️ Если устройство не отключилось корректно, соединение может висеть

### Вариант B: Уникальные конфиги на устройство

Создавать отдельный sub-token для каждого устройства:

```
/connect/abc123-device1  → Устройство 1
/connect/abc123-device2  → Устройство 2
/connect/abc123-device3  → Устройство 3
```

Хранить в БД:
```sql
CREATE TABLE device_configs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  device_fingerprint VARCHAR(32),
  device_name VARCHAR(100), -- "iPhone 15", "Xiaomi Redmi"
  sub_token VARCHAR(64) UNIQUE,
  created_at TIMESTAMP DEFAULT NOW(),
  last_used_at TIMESTAMP
);
```

Логика:
1. Пользователь открывает `/connect/:mainToken`
2. Сервер проверяет fingerprint
3. Если устройство новое и лимит не достигнут → создать новый sub-token
4. Если устройство уже есть → вернуть существующий sub-token
5. Если лимит достигнут → показать ошибку

**Плюсы:**
- ✅ Гибкий контроль (можно показать список устройств)
- ✅ Можно давать названия устройствам ("iPhone Саши", "Рабочий ноутбук")
- ✅ Можно удалять устройства из списка

**Минусы:**
- ⚠️ Fingerprint не 100% надёжен (см. выше)
- ⚠️ Требует доработки UI

## 2. Hybrid-подход (рекомендация)

Комбинировать оба метода:

1. **Мягкое ограничение через device_configs** (fingerprint)
   - Показываем пользователю список устройств
   - Даём возможность отвязать старые устройства

2. **Жёсткое ограничение через 3x-ui maxConnections**
   - Устанавливаем `maxConnections = лимит_тарифа + 1`
   - Защита от злоупотреблений на уровне VPN

### Пример реализации

```typescript
// src/modules/devices/deviceService.ts
export class DeviceService {
  async registerDevice(
    userId: number,
    fingerprint: string,
    deviceInfo: DeviceInfo,
    maxDevices: number,
  ): Promise<{ success: boolean; subToken?: string; error?: string }> {
    // Проверить существующее устройство
    const existing = await prisma.deviceConfig.findFirst({
      where: { userId, fingerprint },
    });

    if (existing) {
      // Обновить last_used_at
      await prisma.deviceConfig.update({
        where: { id: existing.id },
        data: { lastUsedAt: new Date() },
      });
      return { success: true, subToken: existing.subToken };
    }

    // Проверить лимит
    const count = await prisma.deviceConfig.count({
      where: { userId },
    });

    if (count >= maxDevices) {
      return {
        success: false,
        error: `Достигнут лимит устройств (${maxDevices}). Удалите старое устройство.`,
      };
    }

    // Создать новое устройство
    const subToken = generateToken();
    const deviceName = `${deviceInfo.platform} ${deviceInfo.model ?? ""}`.trim();

    await prisma.deviceConfig.create({
      data: {
        userId,
        fingerprint,
        deviceName,
        subToken,
        lastUsedAt: new Date(),
      },
    });

    return { success: true, subToken };
  }

  async listDevices(userId: number) {
    return await prisma.deviceConfig.findMany({
      where: { userId },
      orderBy: { lastUsedAt: "desc" },
    });
  }

  async removeDevice(userId: number, deviceId: number) {
    await prisma.deviceConfig.delete({
      where: { id: deviceId, userId },
    });
  }
}
```

## 3. Мониторинг активных устройств

Добавить в админку/статистику:

```typescript
// Получить активные подключения из 3x-ui
const stats = await xui.getClientStats(email);
console.log(`Active connections: ${stats.activeConnections}`);

// Сравнить с registered devices
const registeredDevices = await deviceService.listDevices(userId);
console.log(`Registered devices: ${registeredDevices.length}`);
```

## Следующие шаги

### Для тестирования (сейчас):
1. ✅ Логирование device fingerprint работает
2. Открой `/connect/:token` с разных устройств
3. Сравни fingerprint — один ли хеш на одном устройстве?

### Для production:
1. Добавить таблицу `device_configs` в Prisma schema
2. Реализовать `DeviceService`
3. Обновить `/connect/:token` endpoint для регистрации устройств
4. Добавить команду бота "Мои устройства" для управления
5. Настроить `maxConnections` в 3x-ui

---

## Вопросы для уточнения:

1. Сколько устройств на 1 подписку хочешь разрешить?
2. Должен ли пользователь видеть список устройств и управлять ими?
3. Есть ли доступ к API 3x-ui для настройки `maxConnections`?

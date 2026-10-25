# ⚡ Бесплатный WEB-прокси для Telegram на Cloudflare Workers

> **Ваш персональный, 100% бесплатный прокси для Telegram (Desktop, Android и iOS) — без аренды серверов, без абонентской платы и с настройкой за 2 минуты.**

<p align="center">
  <a href="https://github.com/amirmarandidev/ProxyGosha/stargazers"><img src="https://img.shields.io/github/stars/amirmarandidev/ProxyGosha?style=for-the-badge&color=gold" alt="GitHub Stars"></a>
  <a href="https://workers.cloudflare.com/"><img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=for-the-badge&logo=cloudflare&logoColor=white" alt="Cloudflare Workers"></a>
  <a href="https://desktop.telegram.org/"><img src="https://img.shields.io/badge/Telegram-WEB%20Proxy-2CA5E0?style=for-the-badge&logo=telegram&logoColor=white" alt="Telegram WEB Proxy"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge" alt="License MIT"></a>
  <img src="https://img.shields.io/badge/Cost-%240%20%2F%20Free-brightgreen?style=for-the-badge" alt="Cost Free">
</p>

<p align="center">
  <a href="README.md"><b>English</b></a> •
  <a href="README.fa.md"><b>فارسی</b></a> •
  <a href="README.ru.md"><b>Русский</b></a> •
  <a href="README.zh.md"><b>简体中文</b></a> •
  <a href="llms.txt"><b>llms.txt</b></a>
</p>

---

### 🌟 Что это такое? (Простыми словами / ELI5)

В экосистеме Telegram появился современный протокол прокси — **WEB Proxy**, поддерживаемый всеми официальными клиентами Telegram (Desktop, Android и iOS, если в их обновлении включена функция WEB-прокси). Вместо того чтобы арендовать дорогой VPS или настраивать сложные конфигурации Linux, этот проект превращает бесплатный бессерверный скрипт **Cloudflare Worker** в ваш собственный защищённый прокси.

* 🌐 **Выглядит как обычный сайт:** Если цензор или посторонний откроет ваш домен в обычном браузере, он увидит лишь стандартную страницу-заглушку с текстом "Welcome - This site is online".
* 🚀 **Быстрый доступ к Telegram:** При подключении клиента Telegram трафик безопасно туннелируется через глобальную сеть Cloudflare напрямую к серверам Telegram.
* 💰 **Стоимость: 0 рублей (Полностью бесплатно):** Работает на бесплатном тарифе Cloudflare. Не требуется ни банковская карта, ни покупка хостинга.

---

### ✨ Преимущества

* 🆓 **Бесплатно навсегда:** Никаких ежемесячных счетов за серверы.
* 📁 **Один файл (`worker.js`):** Не нужно ничего компилировать или устанавливать. Просто скопируйте и вставьте.
* 🛡️ **Встроенная страница-маскировка:** Для веб-браузеров это обычный безобидный сайт.
* ⚡ **Высокая скорость:** Трафик обрабатывается дата-центрами Cloudflare по всему миру.
* 🔒 **Конфиденциальность:** Трафик внутри туннеля защищён сквозным шифрованием MTProto; никто (включая Cloudflare) не может прочитать ваши сообщения.

---

### 🚀 Быстрая настройка за 3 минуты

Следуйте этим простым шагам:

#### Шаг 1: Создайте бесплатный Cloudflare Worker
1. Войдите в свой аккаунт на [Cloudflare Dashboard](https://dash.cloudflare.com/) (или зарегистрируйтесь бесплатно).
2. В левом меню перейдите в **Compute (Workers & Pages)** > **Create application** > **Create Worker**.
3. Задайте любое имя (например, `tg-proxy`) и нажмите **Deploy**.

#### Шаг 2: Вставьте код
1. На странице воркера нажмите кнопку **Edit code** (Редактировать код).
2. Удалите всё содержимое редактора и вставьте весь код из файла [worker.js](worker.js).
3. В правом верхнем углу нажмите **Deploy**.

#### Шаг 3: Получите секретный ключ (Secret)
Откройте адрес вашего воркера в браузере, добавив в конце `?create-secret`:
```text
https://tg-proxy.<ваш-поддомен>.workers.dev/?create-secret
```
Вы увидите сгенерированный 32-значный шестнадцатеричный ключ (например, `e89a409cf5fc08ae7b3b2ad4fd2adf6f`). Скопируйте его!

#### Шаг 4: Укажите Secret в настройках
1. Вернитесь в настройки воркера: **Settings** > **Variables and Secrets**.
2. В блоке **Environment Variables** нажмите **Add**:
   * **Variable name:** `SECRET`
   * **Value:** `<вставьте ваш 32-значный ключ из Шага 3>`
3. Нажмите **Deploy**.

#### Шаг 5: Подключите свой домен (Custom Domain)
1. В настройках воркера перейдите в **Settings** > **Domains & Routes** > **Add** > **Custom Domain**.
2. Введите ваш домен или поддомен (например, `tg.yourdomain.com`), добавленный в Cloudflare.
3. Cloudflare автоматически выпустит бесплатный SSL-сертификат и настроит порт 443.

#### Шаг 6: Подключите Telegram (Desktop, Android и iOS)
В любом клиенте Telegram, где поддерживается тип WEB Proxy (например, Telegram Desktop):
1. Перейдите в **Настройки** > **Продвинутые настройки** > **Тип соединения** > **Использовать свой прокси** > **Добавить прокси**.
2. Выберите тип прокси: **WEB**.
3. Заполните поля:
   * **Хост:** `tg.yourdomain.com`
   * **Порт:** `443`
   * **Ключ (Secret):** `<ваш 32-значный ключ>`
4. Нажмите **Сохранить** и включите прокси. Готово! 🎉

> [!TIP]
> **Ссылка для быстрого подключения в один клик:**  
> Вы можете подключиться сами или поделиться ссылкой следующего формата:  
> `tg://webproxy?server=tg.yourdomain.com&secret=ВАШ_СЕКРЕТ`

---

### ❓ Часто задаваемые вопросы (FAQ)

<details>
<summary><b>Работает ли это на всех клиентах Telegram (Desktop, Android и iOS)?</b></summary>
<b>Да, абсолютно!</b> Данный метод работает на <b>всех клиентах Telegram (Desktop, Android и iOS)</b> при условии, что в установленном обновлении Telegram активирована поддержка типа прокси <b>WEB</b>. В Telegram Desktop этот протокол поддерживается официально из коробки, а на мобильных устройствах (Android и iOS) подключение работает точно так же сразу, как только в обновлении приложения включен выбор WEB-прокси.
</details>

<details>
<summary><b>Можно ли делиться прокси с друзьями?</b></summary>
Да! Просто отправьте им ссылку формата <code>tg://webproxy?...</code>. Для личного использования и близкого круга друзей этого более чем достаточно.
</details>

<details>
<summary><b>Можно ли подключить спонсируемый канал (Ad Tag)?</b></summary>
Нет. Система спонсорских каналов Telegram требует соединения с фиксированным исходящим TCP-портом. Cloudflare Workers работают в распределённой среде с динамической трансляцией портов (NAT), из-за чего специальное рукопожатие со спонсорским сервером Telegram сбрасывается. Прокси подключается напрямую к дата-центрам Telegram стабильно и без рекламы.
</details>

<details>
<summary><b>Безопасно ли это? Может ли Cloudflare читать сообщения?</b></summary>
Абсолютно безопасно. Сообщения в Telegram передаются с использованием сквозного шифрования MTProto. Прокси лишь пересылает зашифрованные пакеты; ни Cloudflare, ни прокси-сервер не могут расшифровать или прочесть вашу переписку.
</details>

---

### ⚠️ Предупреждение

Данный проект создан исключительно в образовательных целях, для изучения сетевых протоколов и личного тестирования. Обратите внимание, что предоставление публичных прокси или VPN через Cloudflare Workers противоречит пункту 2.2.1(j) соглашения об обслуживании Cloudflare. Используйте ответственно.

---

### 💖 Support the Project
This utility is free and open source. If it saves you time and simplifies your routing infrastructure, support ongoing development by giving a ⭐ on GitHub or contributing via crypto:

* 🔹 **USDT (BEP20):** `0xd593ae9D32bEA690EC62460C54BF3951aFFF7803`
* 🔸 **USDT (TRC20):** `THaaHzoTwXfUfcrtYTDXRsMmk9qhnXa56M`

---

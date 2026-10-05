'use strict';

module.exports = {
  consumers: [
    {
      // A contact-form message is emailed to the address the store chose in
      // its account settings (workspaces/accountSettings.js).
      name: 'contact_form_email',
      queue: 'notifications',
      events: ['contact_form.submitted'],
      // eslint-disable-next-line global-require
      handle: (event) => require('./formEmail').send(event),
    },
  ],
};

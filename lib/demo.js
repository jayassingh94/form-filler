// Fictional demo data for trying the extension on test/sample-form.html. Not a real person.
import { newProfile } from './schema.js';

export function demoProfile() {
  const p = newProfile('Demo (fake data)');
  Object.assign(p.personal, {
    salutation: 'Ms', firstName: 'Asha', middleName: 'Kumari', lastName: 'Verma', gender: 'Female',
    dob: '1996-03-07', placeOfBirth: 'Lucknow', maritalStatus: 'Married', nationality: 'Indian',
    religion: 'Hindu', bloodGroup: 'B+', identificationMark: 'Mole on left cheek', aadhaar: '999988887777'
  });
  Object.assign(p.family, { fatherName: 'Ramesh Verma', motherName: 'Sunita Verma', spouseName: 'Vikram Singh' });
  Object.assign(p.contact, { email: 'asha.demo@example.com', countryCode: '+91', mobile: '9000000001', altMobile: '9000000002' });
  Object.assign(p.permanentAddress, {
    houseNo: '12', line1: 'Gandhi Marg', village: 'Aliganj', city: 'Lucknow', district: 'Lucknow',
    state: 'Uttar Pradesh', pincode: '226024', country: 'India'
  });
  p.currentAddress.sameAsPermanent = true;
  Object.assign(p.category, {
    category: 'OBC', certificateNo: 'OBC/2023/123456', certificateDate: '2023-04-15', domicileState: 'Uttar Pradesh', pwd: 'No'
  });
  Object.assign(p.education.class10, { board: 'UP Board', rollNo: '1234567', year: '2011', marksObtained: '452', maxMarks: '600' });
  Object.assign(p.education.class12, { board: 'UP Board', rollNo: '7654321', year: '2013', percentage: '78.4' });
  Object.assign(p.education.graduation, { qualification: 'B.Sc', board: 'University of Lucknow', rollNo: 'LU16-0042', year: '2016', percentage: '71' });
  Object.assign(p.experience, { totalYears: '6' });
  Object.assign(p.work.current, { employer: 'Example Pvt Ltd', designation: 'Data Analyst', from: '2019-07-01' });
  p.custom.push({ label: 'Employee ID', value: 'EX-1042' });
  return p;
}
